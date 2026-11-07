#!/usr/bin/env python3
# (from the SwitchRecomp web builds, MZ Labs, AGPL-3.0)
"""Serves this folder on http://localhost:8080 with the headers the web build needs (cross-origin isolation for
SharedArrayBuffer/threads, wasm MIME type), and a Wisp proxy at /wisp/ for the game's online connections (a browser has no
sockets). Usage: python serve.py [port] [--wisp-local]

The proxy only answers this site's own page, and only reaches public addresses, so no other web page can use it to look
around this computer or its network. --wisp-local lets it reach local addresses too (a course server of your own)."""
import base64, hashlib, http.server, ipaddress, os, socket, struct, sys, threading

WISP_LOCAL = False
BUFFER = 128   # packets a stream may have on their way (Wisp's CONTINUE)


def allowed(host, port):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return None
    for i in infos:
        ip = ipaddress.ip_address(i[4][0])
        if WISP_LOCAL or ip.is_global:
            return i[4][0]
    return None


class Wisp:
    """one browser's WebSocket: Wisp packets, each a binary frame. type u8, stream id u32, payload"""
    def __init__(self, rf, wf):
        self.rf, self.wf, self.lock, self.st = rf, wf, threading.Lock(), {}

    def frame(self, data):
        n = len(data)
        h = bytes([0x82]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack('>H', n) if n < 65536 else bytes([127]) + struct.pack('>Q', n))
        with self.lock:
            self.wf.write(h + data); self.wf.flush()

    def packet(self, t, sid, body=b''): self.frame(struct.pack('<BI', t, sid) + body)

    def read_frame(self):
        msg = b''
        while True:
            b = self.rf.read(2)
            if len(b) < 2: return None
            op, n = b[0] & 15, b[1] & 127
            if n == 126: n = struct.unpack('>H', self.rf.read(2))[0]
            elif n == 127: n = struct.unpack('>Q', self.rf.read(8))[0]
            mask = self.rf.read(4) if b[1] & 128 else b'\0\0\0\0'
            d = bytearray(self.rf.read(n))
            for i in range(n): d[i] ^= mask[i & 3]
            if op == 8: return None
            if op == 9:
                with self.lock: self.wf.write(bytes([0x8A, len(d)]) + d); self.wf.flush()
                continue
            msg += d
            if b[0] & 128: return msg

    def pump(self, sid, s, udp):
        reason = 2
        try:
            while True:
                d = s.recv(65536)
                if not d and not udp: break
                for i in range(0, len(d), 60000): self.packet(2, sid, d[i:i + 60000])
        except OSError:
            reason = 3
        if self.st.pop(sid, None) is not None:
            try: self.packet(4, sid, bytes([reason]))
            except OSError: pass
        s.close()

    def connect(self, sid, kind, port, host):
        ip = allowed(host, port)
        if not ip:
            self.st.pop(sid, None)
            self.packet(4, sid, bytes([0x47 if host else 0x41]))   # (blocked / unknown host)
            return
        try:
            s = socket.socket(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_DGRAM if kind == 2 else socket.SOCK_STREAM)
            s.settimeout(10)
            s.connect((ip, port))
            s.settimeout(None)
            if kind == 1: s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            self.st.pop(sid, None)
            self.packet(4, sid, bytes([0x42]))   # (refused / unreachable)
            return
        with self.lock:   # (what the page sent while this connected goes first)
            e = self.st.get(sid)
            if not e: s.close(); return
            try:
                for d in e[3]: s.sendall(d)
            except OSError: pass
            e[0], e[3] = s, []
        threading.Thread(target=self.pump, args=(sid, s, kind == 2), daemon=True).start()

    def run(self):
        self.packet(3, 0, struct.pack('<I', BUFFER))
        while True:
            m = self.read_frame()
            if m is None: break
            t, sid = struct.unpack_from('<BI', m)
            if t == 1:
                kind, port = struct.unpack_from('<BH', m, 5)
                self.st[sid] = [None, 0, kind, []]
                threading.Thread(target=self.connect, args=(sid, kind, port, m[8:].decode('utf8', 'replace')), daemon=True).start()
            elif t == 2:
                e = self.st.get(sid)
                if not e: continue
                with self.lock:
                    if e[0] is None: e[3].append(bytes(m[5:])); continue
                try:
                    e[0].sendall(m[5:]) if e[2] == 1 else e[0].send(m[5:])
                except OSError:
                    continue
                e[1] += 1
                if e[2] == 1 and e[1] >= BUFFER // 2:
                    e[1] = 0
                    self.packet(3, sid, struct.pack('<I', BUFFER))
            elif t == 4:
                e = self.st.pop(sid, None)
                if e and e[0]:
                    try: e[0].shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    e[0].close()
        for e in list(self.st.values()):
            try: e[0] and e[0].close()
            except OSError: pass


class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{'.wasm': 'application/wasm', '.js': 'text/javascript'})

    def do_GET(self):
        if self.path.rstrip('/') == '/wisp' and self.headers.get('Upgrade', '').lower() == 'websocket': return self.wisp()
        return super().do_GET()

    def wisp(self):
        origin = self.headers.get('Origin', '').split('://')[-1]
        if origin != self.headers.get('Host', ''):   # (a socket isn't held to the same-origin rule: this is that check)
            self.send_error(403); return
        key = self.headers.get('Sec-WebSocket-Key', '')
        acc = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n' % acc).encode())
        self.wfile.flush()
        self.close_connection = True
        try: Wisp(self.rfile, self.wfile).run()
        except (OSError, struct.error): pass

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *a):
        if '404' in (fmt % a): super().log_message(fmt, *a)


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    WISP_LOCAL = '--wisp-local' in sys.argv
    port = int(args[0]) if args else 8080
    print('Super Mario Maker 2: open http://localhost:%d in Chrome or Edge (Ctrl+C stops)' % port, flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
