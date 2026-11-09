function parseJsonField(value, fieldName) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error(`${fieldName} must contain valid JSON.`);
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
}

class InterviewController {
  constructor(interviewService) {
    this.interviewService = interviewService;
  }

  startOrResume = async (req, res, next) => {
    try {
      const { examSessionId } = req.body || {};
      const result = await this.interviewService.startOrResume({
        user: req.user,
        examSessionId,
        clientIp: req.ip,
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  getCurrentState = async (req, res, next) => {
    try {
      const result = await this.interviewService.getCurrentState({
        user: req.user,
        interviewId: req.params.id,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  markQuestionPlayed = async (req, res, next) => {
    try {
      const result = await this.interviewService.markQuestionPlayed({
        user: req.user,
        interviewId: req.params.id,
        turnId: req.params.turnId,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  submitAnswer = async (req, res, next) => {
    try {
      const { transcript, timedOut, signals } = req.body || {};
      const audio = req.file ? req.file.buffer : undefined;
      const contentType = req.file ? req.file.mimetype : (req.body && req.body.contentType);

      const result = await this.interviewService.submitAnswer({
        user: req.user,
        interviewId: req.params.id,
        turnId: req.params.turnId,
        audio,
        contentType,
        transcript: parseJsonField(transcript, 'transcript'),
        timedOut: timedOut === true || timedOut === 'true',
        signals: parseJsonField(signals, 'signals'),
      });

      // Expose the recognized answer text of this turn in the multipart
      // response too (same shape as the `turn:transcribed` socket event).
      const transcribedTurn = await this.interviewService.getTranscribedTurn({
        user: req.user,
        interviewId: req.params.id,
        turnId: req.params.turnId,
      });
      res.json({ ...result, transcribedTurn });
    } catch (error) {
      next(error);
    }
  };

  getTranscript = async (req, res, next) => {
    try {
      const result = await this.interviewService.getTranscript({
        user: req.user,
        interviewId: req.params.id,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  disputeStt = async (req, res, next) => {
    try {
      const { note } = req.body || {};
      const result = await this.interviewService.disputeStt({
        user: req.user,
        interviewId: req.params.id,
        turnId: req.params.turnId,
        note,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { InterviewController };
