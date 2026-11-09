const express = require('express');
const { XLSX_MIME } = require('../controllers/questionController');

/**
 * Build the /questions router. Reads are available to any authenticated user;
 * writes, lifecycle transitions, and the Excel import are restricted to
 * LECTURER accounts via requireAuth + requireRole('LECTURER'). When no auth
 * middleware is supplied the router stays open (kept for narrow callers that
 * wire their own guards), but createApp always passes it.
 */
function createQuestionRouter(questionController, auth = {}) {
  const router = express.Router();
  const { requireAuth, requireRole } = auth;

  const read = requireAuth && requireRole
    ? [requireAuth, requireRole('LECTURER', 'ADMIN')]
    : (requireAuth ? [requireAuth] : []);
  const write = requireAuth && requireRole
    ? [requireAuth, requireRole('LECTURER')]
    : [];

  // Static routes before parameterized ones.
  router.get('/template', ...write, questionController.template);
  router.post(
    '/import',
    ...write,
    express.raw({ type: [XLSX_MIME, 'application/octet-stream'], limit: '10mb' }),
    questionController.import,
  );

  router.post('/approve-batch', ...write, questionController.approveBatch);

  router.post('/', ...write, questionController.create);
  router.get('/', ...read, questionController.list);
  // Revision knowledge is lecturer-only, including reads. The service checks
  // subject scope and optimistic revision identity/version on every mutation.
  router.get('/:id/revision', ...write, questionController.getRevision);
  router.put('/:id/revision', ...write, questionController.saveRevision);
  router.post('/:id/revision/publish', ...write, questionController.publishRevision);
  router.get('/:id/sources', ...read, questionController.sources);
  router.get('/:id', ...read, questionController.getById);
  router.put('/:id', ...write, questionController.update);
  router.delete('/:id', ...write, questionController.remove);

  router.post('/:id/approve', ...write, questionController.approve);
  router.post('/:id/reject', ...write, questionController.reject);
  router.post('/:id/archive', ...write, questionController.archive);

  return router;
}

module.exports = {
  createQuestionRouter,
};
