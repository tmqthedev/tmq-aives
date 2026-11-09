const express = require('express');
const multer = require('multer');

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB audio limit
});

function createInterviewRouter(interviewController, auth = {}) {
  const router = express.Router();
  const { requireAuth, requireRole } = auth;

  const studentGuard = requireAuth && requireRole
    ? [requireAuth, requireRole('STUDENT')]
    : [];

  router.post('/', ...studentGuard, interviewController.startOrResume);
  router.get('/:id', ...studentGuard, interviewController.getCurrentState);
  router.get('/:id/transcript', ...studentGuard, interviewController.getTranscript);
  router.post('/:id/turns/:turnId/played', ...studentGuard, interviewController.markQuestionPlayed);
  router.post('/:id/turns/:turnId/answer', ...studentGuard, upload.single('audio'), interviewController.submitAnswer);
  router.post('/:id/turns/:turnId/stt-dispute', ...studentGuard, interviewController.disputeStt);

  return router;
}

module.exports = { createInterviewRouter };
