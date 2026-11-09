// Resolve the uploaded Excel buffer from the request. Supports a raw body
// buffer (when a raw body parser is mounted) or a JSON body carrying the file
// as base64 under `file` or `data`. Mirrors adminController.resolveImportBuffer.
function resolveImportBuffer(req) {
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    return req.body;
  }
  const body = req.body || {};
  const base64 = body.file || body.data;
  if (typeof base64 === 'string' && base64.length > 0) {
    const commaIdx = base64.indexOf(',');
    const raw = base64.startsWith('data:') && commaIdx !== -1 ? base64.slice(commaIdx + 1) : base64;
    return Buffer.from(raw, 'base64');
  }
  const err = new Error('An Excel file is required (raw body or base64 in `file`).');
  err.statusCode = 400;
  err.code = 'VALIDATION_ERROR';
  throw err;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class QuestionController {
  constructor(questionService) {
    this.questionService = questionService;
  }

  list = async (req, res, next) => {
    try {
      const { status, bloom, source, topicId, topic_id } = req.query || {};
      const questions = await this.questionService.listQuestions({ status, bloom, source, topicId: topicId || topic_id }, req.user);
      res.json(questions);
    } catch (error) {
      next(error);
    }
  };

  getById = async (req, res, next) => {
    try {
      const questionId = this._parseQuestionId(req.params.id);
      const question = await this.questionService.getQuestionById(questionId, req.user);
      res.json(question);
    } catch (error) {
      next(error);
    }
  };

  create = async (req, res, next) => {
    try {
      const payload = { ...(req.body || {}) };
      // Never trust a client-supplied author.
      payload.createdBy = req.user ? req.user.id : undefined;
      const result = await this.questionService.createQuestion(payload, req.user);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  };

  update = async (req, res, next) => {
    try {
      const questionId = this._parseQuestionId(req.params.id);
      const question = await this.questionService.updateQuestion(questionId, req.body || {}, req.user);
      res.json(question);
    } catch (error) {
      next(error);
    }
  };

  getRevision = async (req, res, next) => {
    try {
      res.json(await this.questionService.getPendingRevision(this._parseQuestionId(req.params.id), req.user));
    } catch (error) { next(error); }
  };

  saveRevision = async (req, res, next) => {
    try {
      const { patch, expectedVersion, revisionId } = req.body || {};
      res.json(await this.questionService.saveRevision(this._parseQuestionId(req.params.id), {
        patch, expectedVersion, revisionId,
      }, req.user));
    } catch (error) { next(error); }
  };

  publishRevision = async (req, res, next) => {
    try {
      const { expectedVersion, revisionId } = req.body || {};
      res.json(await this.questionService.publishRevision(this._parseQuestionId(req.params.id), {
        expectedVersion, revisionId,
      }, req.user));
    } catch (error) { next(error); }
  };

  remove = async (req, res, next) => {
    try {
      const questionId = this._parseQuestionId(req.params.id);
      const question = await this.questionService.deleteQuestion(questionId, req.user);
      res.json(question);
    } catch (error) {
      next(error);
    }
  };

  // --- Lifecycle ----------------------------------------------------------

  approve = async (req, res, next) => {
    try {
      const questionId = this._parseQuestionId(req.params.id);
      const reviewedBy = req.user ? req.user.id : undefined;
      const question = await this.questionService.approve(questionId, { reviewedBy, user: req.user });
      res.json(question);
    } catch (error) {
      next(error);
    }
  };

  reject = async (req, res, next) => {
    try {
      const questionId = this._parseQuestionId(req.params.id);
      const reviewedBy = req.user ? req.user.id : undefined;
      const { reason } = req.body || {};
      const question = await this.questionService.reject(questionId, { reason, reviewedBy, user: req.user });
      res.json(question);
    } catch (error) {
      next(error);
    }
  };

  archive = async (req, res, next) => {
    try {
      const questionId = this._parseQuestionId(req.params.id);
      const question = await this.questionService.archive(questionId, { user: req.user });
      res.json(question);
    } catch (error) {
      next(error);
    }
  };

  approveBatch = async (req, res, next) => {
    try {
      const { questionIds, rubricId } = req.body || {};
      const reviewedBy = req.user ? req.user.id : undefined;
      const questions = await this.questionService.approveBatch({
        questionIds, rubricId, reviewedBy, user: req.user,
      });
      res.json(questions);
    } catch (error) {
      next(error);
    }
  };

  sources = async (req, res, next) => {
    try {
      const questionId = this._parseQuestionId(req.params.id);
      const sources = await this.questionService.getQuestionSources(questionId, req.user);
      res.json(sources);
    } catch (error) {
      next(error);
    }
  };

  // --- Excel import -------------------------------------------------------

  template = async (_req, res, next) => {
    try {
      const buffer = await this.questionService.buildImportTemplate();
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Disposition', 'attachment; filename="question-import-template.xlsx"');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  };

  import = async (req, res, next) => {
    try {
      const buffer = resolveImportBuffer(req);
      const result = await this.questionService.importQuestions(buffer, req.user);
      if (!result.ok) {
        res.status(422).json(result);
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  };

  _parseQuestionId(rawId) {
    const questionId = Number(rawId);
    if (!Number.isInteger(questionId) || questionId <= 0) {
      const err = new Error('Question id must be a positive integer.');
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    return questionId;
  }
}

module.exports = {
  QuestionController,
  resolveImportBuffer,
  XLSX_MIME,
};
