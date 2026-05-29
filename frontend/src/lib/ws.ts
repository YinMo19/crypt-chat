/** Server protocol frames (must match src/protocol.rs). */

export interface MemberInfo {
  id: string;
  /** base64 MLS KeyPackage. Kept as `public_key` for server compatibility. */
  public_key: string;
}

export type ServerMsg =
  | { type: 'joined'; your_id: string; members: MemberInfo[] }
  | { type: 'member_joined'; id: string; public_key: string }
  | { type: 'member_left'; id: string }
  | { type: 'message'; from: string; ts: number; envelope: string }
  | { type: 'error'; reason: string };

export type ClientMsg =
  | { type: 'join'; room: string; public_key: string }
  | {
      type: 'relay';
      /** When set, the server unicasts to this peer only; otherwise broadcasts. */
      to?: string;
      envelope: string;
    };

/** Minimal WebSocket client. Picks ws/wss based on the page protocol. */
export class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: ServerMsg) => void>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws`;
      const ws = new WebSocket(url);
      let opened = false;
      let settled = false;
      this.ws = ws;
      ws.onopen = () => {
        opened = true;
        settled = true;
        this.openListeners.forEach((l) => l());
        resolve();
      };
      ws.onerror = (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      ws.onmessage = (ev) => {
        try {
          const msg: ServerMsg = JSON.parse(ev.data);
          this.listeners.forEach((l) => l(msg));
        } catch (e) {
          console.error('bad server frame', e);
        }
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (!opened && !settled) {
          settled = true;
          reject(new Error('websocket closed before open'));
        }
        this.closeListeners.forEach((l) => l());
      };
    });
  }

  send(msg: ClientMsg): boolean {
    if (!this.isOpen()) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => this.openListeners.delete(cb);
  }

  onMessage(cb: (m: ServerMsg) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
