"""Kiểm vị trí include và phạm vi tuyến K67; không đọc/sửa Nginx thật."""
from pathlib import Path
import importlib.util
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('cutover',ROOT/'ops/nginx-cutover.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class Scope(unittest.TestCase):
    def block(self,port=443,host='ducizone.ddns.net'):
        return f'server {{\n listen {port} ssl;\n server_name {host};\n    {c.ANCHOR}\n location /mapping-api/ {{ proxy_pass http://old/; }}\n}}\n'
    def test_only_correct_tls_server(self):
        raw=(self.block(80)+self.block()+self.block(443,'foreign.example')).encode()
        out=c.add_include(raw);self.assertEqual(out.replace(('    include '+c.INCLUDE+';\n').encode(),b'',1),raw)
        self.assertEqual(out.count(c.INCLUDE.encode()),1)
    def test_foreign_server_anchor_not_accepted(self):
        with self.assertRaisesRegex(RuntimeError,'AMBIGUOUS'):c.add_include(self.block(443,'foreign.example').encode())
    def test_duplicate_server_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'AMBIGUOUS'):c.add_include((self.block()*2).encode())
    def test_comment_and_quoted_braces_do_not_change_scope(self):
        raw=self.block().replace(' location /mapping-api/', '# server { wrong }\n set $x "{}";\n location /mapping-api/').encode()
        self.assertIn(c.INCLUDE.encode(),c.add_include(raw))
    def test_duplicate_or_missing_anchor_rejected(self):
        for raw in [self.block().replace(c.ANCHOR,''),self.block().replace(c.ANCHOR,c.ANCHOR+'\n'+c.ANCHOR)]:
            with self.assertRaisesRegex(RuntimeError,'ANCHOR'):c.add_include(raw.encode())
    def test_quoted_anchor_is_not_a_server_directive(self):
        raw=self.block().replace(c.ANCHOR,'set $x "\n'+c.ANCHOR+'\n";')
        with self.assertRaisesRegex(RuntimeError,'ANCHOR'):c.add_include(raw.encode())
    def test_nested_anchor_is_not_a_direct_server_child(self):
        raw=self.block().replace(c.ANCHOR,'location /nested/ {\n'+c.ANCHOR+'\n}')
        with self.assertRaisesRegex(RuntimeError,'ANCHOR_NOT_DIRECT'):c.add_include(raw.encode())
    def test_mini_key_scope(self):
        result=c.legacy_map('a'*32,'b'*48,'c'*48)
        self.assertIn(b'default "";',result);self.assertEqual(result.count(b'~^' + b'b'*48+b'$'),1)
        pattern=result.decode().split('~^')[1].split('$')[0]
        import re
        self.assertIsNotNone(re.fullmatch(pattern,'b'*48));self.assertIsNone(re.fullmatch(pattern,'B'*48))
        with self.assertRaisesRegex(RuntimeError,'SECRET_INVALID'):c.legacy_map('a'*32,'quote"','c'*48)
    def test_routes_leave_other_products_and_auth_untouched(self):
        result=c.legacy_routes('a'*32,False).decode()
        self.assertIn('location = /mapping-api/api/mini-tests/results',result)
        self.assertIn('proxy_set_header x-mini-test-sync $k67_legacy_mini_key',result)
        self.assertIn('location ^~ /mapping-api/api/term-tests/teacher/',result)
        for forbidden in ['location /mapping-api/ {','/mapping-api/api/auth/','/mapping-api-k56/','progress-log','speaking']:
            self.assertNotIn(forbidden,result)
    def test_hold_only_k67_namespaces(self):
        result=c.legacy_routes('a'*32,True).decode()
        self.assertEqual(result.count('return 503'),3);self.assertNotIn('proxy_pass',result)
if __name__=='__main__':unittest.main()
