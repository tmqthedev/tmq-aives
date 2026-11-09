const { v4: uuidv4 } = require('uuid');

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

// Accepted upload types keyed by MIME, with their canonical extensions. Used
// for both MIME validation and (as a fallback) extension sniffing.
const ACCEPTED_TYPES = {
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
};

const EXT_TO_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function extensionOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

class MaterialService {
  constructor({
    courseMaterialRepository,
    subjectRepository,
    topicRepository,
    awsClients,
    enqueueJob,
    env,
    realtimeBus,
    logger = console,
  }) {
    this.courseMaterialRepository = courseMaterialRepository;
    this.subjectRepository = subjectRepository;
    this.topicRepository = topicRepository;
    this.awsClients = awsClients;
    this.enqueueJob = enqueueJob;
    this.env = env || {};
    this.realtimeBus = realtimeBus || null;
    this.logger = logger;
    this.bucket = this.env.materialsBucket || 'local-materials-bucket';
  }

  // ADMIN bypasses the scope check; a LECTURER must be assigned to the subject.
  async _assertSubjectInScope(user, subjectId) {
    if (user && user.role === 'ADMIN') return;
    const lecturerId = user ? user.id : undefined;
    const subjectIds = await this.subjectRepository.listSubjectIdsForLecturer(lecturerId);
    if (!subjectIds.includes(subjectId)) {
      throw httpError(403, 'FORBIDDEN', 'You do not have access to this subject.');
    }
  }

  _parseSubjectId(raw) {
    const subjectId = Number(raw);
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'A valid subjectId is required.');
    }
    return subjectId;
  }

  // Finding 2: validate subjectId BEFORE any S3 put or DB insert, so an invalid
  // or missing subject never produces an orphan object or row.
  async upload({ user, subjectId: rawSubjectId, topicId: rawTopicId, file } = {}) {
    const subjectId = this._parseSubjectId(rawSubjectId);

    if (!file || !file.buffer) {
      throw httpError(400, 'VALIDATION_ERROR', 'A file is required.');
    }

    // Resolve the type via MIME, falling back to the filename extension.
    let mimeType = file.mimetype;
    if (!ACCEPTED_TYPES[mimeType]) {
      const ext = extensionOf(file.originalname);
      mimeType = EXT_TO_MIME[ext];
    }
    if (!mimeType || !ACCEPTED_TYPES[mimeType]) {
      throw httpError(400, 'UNSUPPORTED_TYPE', 'Only PDF, DOCX, and PPTX files are supported.');
    }

    // Optional topic must belong to the same subject.
    let topicId = null;
    if (rawTopicId !== undefined && rawTopicId !== null && rawTopicId !== '') {
      topicId = Number(rawTopicId);
      if (!Number.isInteger(topicId) || topicId <= 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'topicId must be a positive integer.');
      }
      const topic = await this.topicRepository.getById(topicId);
      if (!topic) {
        throw httpError(404, 'TOPIC_NOT_FOUND', 'Topic not found.');
      }
      if (topic.subject_id != null && Number(topic.subject_id) !== subjectId) {
        throw httpError(400, 'VALIDATION_ERROR', 'The topic does not belong to this subject.');
      }
    }

    await this._assertSubjectInScope(user, subjectId);

    const title = file.originalname || `material-${Date.now()}`;
    const fileKey = `materials/${subjectId}/${uuidv4()}/${title}`;

    try {
      await this.awsClients.putObject({
        bucket: this.bucket,
        key: fileKey,
        body: file.buffer,
        contentType: mimeType,
      });
    } catch (err) {
      this.logger.error({ err, fileKey }, 'material upload to storage failed');
      throw httpError(502, 'STORAGE_ERROR', 'Could not store the uploaded file.');
    }

    const material = await this.courseMaterialRepository.create({
      subjectId,
      topicId,
      title,
      fileKey,
      mimeType,
      sizeBytes: file.size ?? (file.buffer ? file.buffer.length : null),
      pageCount: null,
      status: 'UPLOADED',
      uploadedBy: user ? user.id : null,
    });

    this._publishMaterial(material, 'created');

    await this.enqueueJob('INGEST_MATERIAL', { materialId: material.course_material_id });

    return material;
  }

  async list({ user, subjectId: rawSubjectId } = {}) {
    const subjectId = this._parseSubjectId(rawSubjectId);
    await this._assertSubjectInScope(user, subjectId);
    return this.courseMaterialRepository.listBySubject(subjectId);
  }

  async delete({ user, materialId: rawMaterialId } = {}) {
    const materialId = Number(rawMaterialId);
    if (!Number.isInteger(materialId) || materialId <= 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'A valid material id is required.');
    }

    const material = await this.courseMaterialRepository.findById(materialId);
    if (!material) {
      throw httpError(404, 'NOT_FOUND', 'Material not found.');
    }

    await this._assertSubjectInScope(user, Number(material.subject_id));

    const citing = await this.courseMaterialRepository.countCitingQuestions(materialId);
    if (citing > 0) {
      throw httpError(409, 'MATERIAL_IN_USE', 'This material is cited by existing questions.');
    }

    // Best-effort object delete: a missing object must not block the DB delete.
    try {
      await this.awsClients.deleteObject({ bucket: this.bucket, key: material.file_key });
    } catch (err) {
      if (err && err.code === 'NoSuchKey') {
        this.logger.warn({ materialId }, 'material object already gone; continuing delete');
      } else {
        throw httpError(502, 'STORAGE_ERROR', 'Could not delete the stored file.');
      }
    }

    const deleted = await this.courseMaterialRepository.deleteById(materialId);
    this._publishMaterial(material, 'deleted', materialId);
    return deleted;
  }

  _publishMaterial(material, action, fallbackId = null) {
    if (!this.realtimeBus || typeof this.realtimeBus.publish !== 'function' || !material) return;
    try {
      this.realtimeBus.publish('material', {
        action,
        materialId: Number(material.course_material_id ?? fallbackId),
        subjectId: material.subject_id == null ? null : Number(material.subject_id),
      });
    } catch (err) {
      this.logger.warn({ err }, 'material realtime publish failed');
    }
  }
}

module.exports = { MaterialService };
