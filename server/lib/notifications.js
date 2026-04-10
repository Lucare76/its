const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function sendNotification(payload) {
  emitter.emit('message', payload);
}

function createSseHandler() {
  return (req, res) => {
    const user = req.user;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const write = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const shouldSend = (payload) => {
      if (!payload) return false;
      if (!payload.audience || payload.audience === 'ALL') return true;
      if (!user) return false;
      if (payload.userId && payload.userId === user.sub) return true;
      if (payload.audience === 'OPERATOR') return user.role === 'OPERATOR';
      if (payload.audience === 'AGENCY') {
        if (user.role !== 'AGENCY') return false;
        if (payload.agencyId && payload.agencyId !== user.sub) return false;
        return true;
      }
      return true;
    };

    const onMessage = (payload) => {
      if (!shouldSend(payload)) return;
      write(payload);
    };
    emitter.on('message', onMessage);

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      emitter.off('message', onMessage);
    });
  };
}

module.exports = {
  sendNotification,
  createSseHandler,
};
