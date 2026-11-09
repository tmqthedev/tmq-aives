class ExamSessionController {
  constructor(examSessionService) {
    this.examSessionService = examSessionService;
  }

  create = async (req, res, next) => {
    try {
      const session = await this.examSessionService.createSession({
        user: req.user,
        ...(req.body || {}),
      });
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  };

  getMonitoring = async (req, res, next) => {
    try {
      res.json(await this.examSessionService.getInterviewCounts({ user: req.user }));
    } catch (error) {
      next(error);
    }
  };

  list = async (req, res, next) => {
    try {
      const sessions = await this.examSessionService.listSessions({ user: req.user });
      res.json(sessions);
    } catch (error) {
      next(error);
    }
  };

  getProgress = async (req, res, next) => {
    try {
      res.json(await this.examSessionService.getLecturerProgress({ user: req.user }));
    } catch (error) {
      next(error);
    }
  };

  getOptions = async (req, res, next) => {
    try {
      const options = await this.examSessionService.getCreateOptions({ user: req.user });
      res.json(options);
    } catch (error) {
      next(error);
    }
  };

  getById = async (req, res, next) => {
    try {
      const session = await this.examSessionService.getSession({
        user: req.user,
        examSessionId: req.params.id,
      });
      res.json(session);
    } catch (error) {
      next(error);
    }
  };

  update = async (req, res, next) => {
    try {
      const session = await this.examSessionService.updateSession({
        user: req.user,
        examSessionId: req.params.id,
        ...(req.body || {}),
      });
      res.json(session);
    } catch (error) {
      next(error);
    }
  };

  setStudents = async (req, res, next) => {
    try {
      const result = await this.examSessionService.setStudents({
        user: req.user,
        examSessionId: req.params.id,
        codes: (req.body || {}).codes,
        studentIds: (req.body || {}).studentIds,
      });
      if (!result.ok) {
        res.status(422).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  setExaminers = async (req, res, next) => {
    try {
      const result = await this.examSessionService.setExaminers({
        user: req.user,
        examSessionId: req.params.id,
        lecturerIds: (req.body || {}).lecturerIds,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  // Lecturer submits the schedule: DRAFT -> SCHEDULED (Step 12). The exam is
  // opened by an ADMIN via /api/admin/exam-sessions/:id/start.
  schedule = async (req, res, next) => {
    try {
      const session = await this.examSessionService.scheduleSession({
        user: req.user,
        examSessionId: req.params.id,
      });
      res.json(session);
    } catch (error) {
      next(error);
    }
  };

  // Lecturer withdraws the schedule: SCHEDULED -> DRAFT.
  unschedule = async (req, res, next) => {
    try {
      const session = await this.examSessionService.unscheduleSession({
        user: req.user,
        examSessionId: req.params.id,
      });
      res.json(session);
    } catch (error) {
      next(error);
    }
  };

  close = async (req, res, next) => {
    try {
      const session = await this.examSessionService.closeSession({
        user: req.user,
        examSessionId: req.params.id,
      });
      res.json(session);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { ExamSessionController };
