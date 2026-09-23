// Giữ các kết nối trình duyệt đang chờ và chỉ báo khi điểm Writing đã sẵn sàng.
// Dữ liệu kết quả không đi qua kênh này; trình duyệt vẫn phải gọi API kết quả để đọc điểm.
export function createTermTestResultEvents({
  heartbeatMs = 10_000,
  maxLifetimeMs = 45 * 60_000,
  recentReadyTtlMs = 60_000,
  maxConnections = 2_000,
  maxConnectionsPerAttempt = 4
} = {}) {
  const subscribers = new Map();
  const recentReady = new Map();
  let connectionCount = 0;
  let closed = false;

  function pruneRecentReady(now = Date.now()) {
    for (const [attemptToken, expiresAt] of recentReady) {
      if (expiresAt <= now) recentReady.delete(attemptToken);
    }
  }

  function removeConnection(connection) {
    if (!connection || connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.heartbeatTimer);
    clearTimeout(connection.lifetimeTimer);
    connection.req.off?.('aborted', connection.onClosed);
    connection.res.off?.('close', connection.onClosed);
    const group = subscribers.get(connection.attemptToken);
    if (group?.delete(connection)) connectionCount -= 1;
    if (group?.size === 0) subscribers.delete(connection.attemptToken);
  }

  function finishConnection(connection, eventName = '') {
    if (!connection || connection.closed) return;
    if (!connection.res.writableEnded && !connection.res.destroyed) {
      if (eventName) connection.res.write(`event: ${eventName}\ndata: {}\n\n`);
      connection.res.end();
    }
    removeConnection(connection);
  }

  function scheduleHeartbeat(connection) {
    connection.heartbeatTimer = setTimeout(() => {
      if (connection.closed || connection.res.writableEnded || connection.res.destroyed) {
        removeConnection(connection);
        return;
      }
      connection.res.write(': keep-alive\n\n');
      scheduleHeartbeat(connection);
    }, heartbeatMs);
    connection.heartbeatTimer.unref?.();
  }

  function subscribe({ attemptToken, req, res, ready = false }) {
    pruneRecentReady();
    const group = subscribers.get(attemptToken);
    if (closed || connectionCount >= maxConnections || (group?.size || 0) >= maxConnectionsPerAttempt) {
      return { accepted: false, reason: closed ? 'closed' : 'capacity' };
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    const connection = {
      attemptToken,
      req,
      res,
      closed: false,
      heartbeatTimer: null,
      lifetimeTimer: null,
      onClosed: null
    };
    connection.onClosed = () => removeConnection(connection);
    req.once?.('aborted', connection.onClosed);
    res.once?.('close', connection.onClosed);
    const nextGroup = group || new Set();
    nextGroup.add(connection);
    subscribers.set(attemptToken, nextGroup);
    connectionCount += 1;

    res.write('retry: 2000\n\n');
    if (ready || recentReady.has(attemptToken)) {
      finishConnection(connection, 'ready');
      return { accepted: true, ready: true };
    }

    scheduleHeartbeat(connection);
    connection.lifetimeTimer = setTimeout(() => finishConnection(connection, 'close'), maxLifetimeMs);
    connection.lifetimeTimer.unref?.();
    return { accepted: true, ready: false };
  }

  function publishReady(attemptToken) {
    if (!attemptToken || closed) return 0;
    pruneRecentReady();
    recentReady.set(attemptToken, Date.now() + recentReadyTtlMs);
    const group = subscribers.get(attemptToken);
    if (!group) return 0;
    const connections = [...group];
    for (const connection of connections) finishConnection(connection, 'ready');
    return connections.length;
  }

  function closeAll() {
    closed = true;
    for (const group of [...subscribers.values()]) {
      for (const connection of [...group]) finishConnection(connection, 'close');
    }
    recentReady.clear();
  }

  function stats() {
    return { connectionCount, attemptCount: subscribers.size, closed };
  }

  return { subscribe, publishReady, closeAll, stats };
}
