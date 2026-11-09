const { Router } = require('express');
const express = require('express');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Build the /admin router. The entire router is guarded by requireAuth and
 * requireRole('ADMIN') from FEAT-001. The student-import route additionally
 * accepts a raw binary body (xlsx/octet-stream) in addition to the global JSON
 * parser's base64 path.
 */
function createAdminRouter(controller, { requireAuth, requireRole }) {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN'));

  // Users
  router.get('/users', controller.listUsers.bind(controller));
  router.post('/users', controller.createUser.bind(controller));
  router.post(
    '/users/import',
    express.raw({ type: [XLSX_MIME, 'application/octet-stream'], limit: '10mb' }),
    controller.importStudents.bind(controller),
  );
  router.get('/users/:id/assignments', controller.getUserAssignments.bind(controller));
  router.put('/users/:id', controller.updateUser.bind(controller));
  router.delete('/users/:id', controller.deleteUser.bind(controller));
  router.post('/users/:id/lock', controller.lockUser.bind(controller));
  router.post('/users/:id/unlock', controller.unlockUser.bind(controller));
  router.post('/users/:id/resend-setup', controller.resendSetup.bind(controller));

  // Subjects
  router.get('/subjects', controller.listSubjects.bind(controller));
  router.post('/subjects', controller.createSubject.bind(controller));
  router.put('/subjects/:id', controller.updateSubject.bind(controller));
  router.delete('/subjects/:id', controller.deleteSubject.bind(controller));
  router.post('/subjects/:id/archive', controller.archiveSubject.bind(controller));
  router.post('/subjects/:id/unarchive', controller.unarchiveSubject.bind(controller));
  router.put('/subjects/:id/lecturers', controller.assignLecturers.bind(controller));
  router.get('/subjects/:id/lecturers', controller.listSubjectLecturers.bind(controller));
  router.get('/subjects/:id/students', controller.listSubjectStudents.bind(controller));
  router.put('/subjects/:id/students', controller.assignStudents.bind(controller));

  // Exam schedule (Step 12): list, start (SCHEDULED -> OPEN + warm-up), close,
  // manual re-warm.
  router.get('/exam-schedule', controller.listExamSchedule.bind(controller));
  router.get('/exam-monitoring', controller.getExamMonitoring.bind(controller));
  router.get('/audit-log', controller.listAuditLog.bind(controller));
  router.post('/exam-sessions', controller.createExamSession.bind(controller));
  router.put('/exam-sessions/:id', controller.updateExamSession.bind(controller));
  router.delete('/exam-sessions/:id', controller.deleteExamSession.bind(controller));
  router.post('/exam-sessions/:id/start', controller.startExamSession.bind(controller));
  router.post('/exam-sessions/:id/close', controller.closeExamSession.bind(controller));
  router.post('/exam-sessions/:id/warm', controller.warmExamSession.bind(controller));

  return router;
}

module.exports = { createAdminRouter };
