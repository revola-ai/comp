import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CLOSE_GRACE_MS, closeGracefully } from './readiness-probe';

// A socket stand-in: closes when told to, as a server closing the connection would.
class FakeSocket extends EventEmitter {
  destroyed = false;
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

describe('closeGracefully', () => {
  it('waits for the socket to close even when client.end() resolves first', async () => {
    // A client whose end() resolves before its socket has closed.
    const socket = new FakeSocket();
    let settled = false;
    const closing = closeGracefully({
      client: { end: () => Promise.resolve() },
      socket,
      destroy: () => socket.close(),
    }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    socket.close();
    await closing;
    expect(settled).toBe(true);
  });

  it('settles at once when the socket is already closed', async () => {
    const socket = new FakeSocket();
    socket.close();
    await closeGracefully({
      client: { end: () => Promise.resolve() },
      socket,
      destroy: () => socket.close(),
    });
  });

  it('destroys a socket the server never closes after CLOSE_GRACE_MS', async () => {
    const socket = new FakeSocket();
    const started = performance.now();
    await closeGracefully({
      client: { end: () => Promise.resolve() },
      socket,
      destroy: () => socket.close(),
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 5);
    expect(socket.destroyed).toBe(true);
  });
});
