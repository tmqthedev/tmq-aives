// RealtimeBus: in-process EventEmitter that services use to broadcast
// invalidation events after successful writes. The Socket.IO namespace
// subscribes to this bus and fans the events out to authenticated clients
// in the correct rooms (role, subject, exam).
//
// Payload shape is service-owned and entity-specific. RealtimeSocket reduces
// every event to an explicit allowlist before fanout; content fields are dropped.
//
// entity: exam | interview | result | material | rubric | question | user | subject
// action: 'created' | 'updated' | 'deleted' | 'status_changed' | 'completed'
//          | 'grading_progress' | 'finalized' | 'reopened'
// summary: aggregate counts for admin/lecturer monitoring (never raw answers).

const EventEmitter = require('node:events');

class RealtimeBus extends EventEmitter {
  constructor() {
    super();
    // Prevent crashes from unhandled listener errors
    this.setMaxListeners(50);
  }

  /**
   * Emit a business invalidation event.
   * @param {string} entity  – 'exam' | 'interview' | 'result'
   * @param {object} payload – { action, subjectId?, examSessionId?, ... }
   */
  publish(entity, payload) {
    this.emit('invalidation', { entity, ...payload, ts: Date.now() });
  }
}

module.exports = { RealtimeBus };
