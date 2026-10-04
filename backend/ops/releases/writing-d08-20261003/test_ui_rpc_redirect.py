"""Thực thi đúng Node transport với HTTP localhost giả: redirect không tới đích phụ."""
import json,subprocess,threading,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from unittest.mock import patch
import ui_rpc_remote as remote
class RedirectFence(unittest.TestCase):
    def test_redirect_never_posts_to_second_destination(self):
        calls=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length',0)));calls.append(self.path)
                if self.path=='/api/term-tests/writing':
                    self.send_response(307);self.send_header('Location','/wrong-destination');self.end_headers()
                else:
                    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"ok":true}')
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        original=subprocess.run
        def owned_transport(command,**kwargs):
            # Docker nằm ngoài unit; giữ nguyên Node source/payload thật từ ProductionBackend.post.
            return original(command[5:],**kwargs)
        try:
            entry={'destination':{'container':'owned-fixture','public_api_base':'http://127.0.0.1:'+str(server.server_port)}}
            with patch.object(remote.subprocess,'run',side_effect=owned_transport):
                with self.assertRaisesRegex(ValueError,'sender_or_http_unknown'):
                    remote.ProductionBackend({},[]).post(entry,{'synthetic':True})
            self.assertEqual(calls,['/api/term-tests/writing'])
        finally:server.shutdown();server.server_close();thread.join(timeout=5)
if __name__=='__main__':unittest.main()
