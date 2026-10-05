"""Kiểm phục hồi bằng Docker giả và archive thật cỡ nhỏ, không truy cập VPS.
Nhận trạng thái ba API giả; gây mất phản hồi sau mỗi thao tác, rồi đọc lại
ID, tên, image, cấu hình và mạng gốc. Assertion lỗi chặn phát hành thật.
"""
import copy
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit
from test_release_adapter import a, fixture, r


class DockerFixture:
    def __init__(self, failure=None, failure_target=0):
        self.failure = failure
        self.failure_target = failure_target
        self.did_fail = False
        self.containers = {}
        self.manifest = {'targets': []}
        self.expected = []
        for index in range(3):
            old = fixture()
            old['Id'] = str(index+1)*64
            old['Name'] = '/api-fixture-'+str(index)
            old['Image'] = 'sha256:base-'+str(index)
            old['NetworkSettings']['Networks']['fixture-network']['Aliases'] = [old['Name'][1:], old['Id'][:12]]
            self.containers[old['Id']] = old
            self.manifest['targets'].append({'name':old['Name'][1:],'base_image':old['Image'],'candidate_image':'sha256:candidate-'+str(index),'source_hashes':{}})
        self.expected = self.probe(self.manifest)

    def inspect(self, name):
        for item in self.containers.values():
            if name in (item['Id'],item['Name'][1:]):
                return copy.deepcopy(item)
        raise RuntimeError('docker_api_failed_404')

    def fail_after(self, phase, item):
        if not self.did_fail and self.failure == phase and item['Name'].startswith('/api-fixture-'+str(self.failure_target)):
            self.did_fail = True
            raise RuntimeError('fixture_response_lost_after_'+phase)

    def api(self, method, url, body=None):
        parsed = urlsplit(url)
        parts = [unquote(part) for part in parsed.path.split('/') if part]
        query = parse_qs(parsed.query)
        if parts[:2] == ['containers','create']:
            name = query['name'][0]
            identifier = hashlib.sha256(name.encode()).hexdigest()
            config = copy.deepcopy(body)
            host = config.pop('HostConfig')
            networks = config.pop('NetworkingConfig')['EndpointsConfig']
            original = self.inspect(name+'-d08-backup-'+('1'*12))
            item = copy.deepcopy(original)
            item.update({'Id':identifier,'Name':'/'+name,'Image':config['Image'],'Config':config,'HostConfig':host,'State':{'Running':False,'Health':{'Status':'starting'}}})
            item['NetworkSettings']['Networks'] = {network:{'Aliases':entry['Aliases']+[identifier[:12]],'IPAMConfig':None,'Links':None} for network,entry in networks.items()}
            self.containers[identifier] = item
            self.fail_after('create',item)
            return {'Id':identifier}
        if parts[0] == 'containers':
            item = self.containers[parts[1]]
            if method == 'DELETE':
                if query.get('v') != ['false']:
                    raise AssertionError('Recovery must preserve data volumes')
                del self.containers[parts[1]]
                return None
            operation = parts[2]
            if operation == 'stop':
                item['State']['Running'] = False
                item['State']['ExitCode'] = 0
            elif operation == 'rename':
                item['Name'] = '/'+query['name'][0]
            elif operation == 'start':
                item['State'] = {'Running':True,'Health':{'Status':'healthy'}}
            else:
                raise AssertionError(operation)
            self.fail_after(operation,item)
            return None
        if parts[0] == 'networks':
            item = self.containers[body['Container']]
            network = parts[1]
            if parts[2] == 'disconnect':
                item['NetworkSettings']['Networks'].pop(network)
                self.fail_after('disconnect',item)
            elif parts[2] == 'connect':
                item['NetworkSettings']['Networks'][network] = {'Aliases':body['EndpointConfig']['Aliases']+[item['Id'][:12]],'IPAMConfig':None,'Links':None}
            else:
                raise AssertionError(parts)
            return None
        raise AssertionError((method,url))

    def probe(self, manifest):
        rows = []
        for target in manifest['targets']:
            item = self.inspect(target['name'])
            rows.append({'name':target['name'],'image':item['Image'],'config_hash':r.digest(r.config_view(item)),'source_hash':r.digest(item['Image']),'container_id':item['Id'],'running':item['State']['Running'],'healthy':item['State']['Health']['Status'],'restart_count':0})
        return rows

    def healthy(self, identifier):
        item = self.containers[identifier]
        self.fail_after('health',item)
        if not item['State']['Running']:
            raise AssertionError('Stopped container')


class RecoveryContracts(unittest.TestCase):
    def exercise(self, phase, target=0):
        docker = DockerFixture(phase,target)
        request = {'manifest':docker.manifest,'expected':docker.expected,'run_id':'1'*32}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # Fsync directory Linux dùng trên VPS; fixture Windows chỉ mock syscall này.
            with patch.object(r,'RELEASE_ROOT',root), patch.object(r,'probe',docker.probe), patch.object(r,'inspect',docker.inspect), patch.object(r,'api',docker.api), patch.object(r,'wait_healthy',docker.healthy), patch.object(r,'active_writing',return_value=[{'active':0}]), patch.object(r,'verify_backup',return_value={}), patch.object(r,'image_hashes',return_value={}), patch.object(r,'stopped_activity',return_value={'active':0}), patch.object(r,'write_receipt',side_effect=lambda path,value:path.write_text(json.dumps(value),encoding='utf-8')):
                if phase:
                    with self.assertRaisesRegex(RuntimeError,'fixture_response_lost'):
                        r.switch(request)
                    self.assertTrue(docker.did_fail)
                else:
                    self.assertEqual(r.switch(request)['status'],'deployed_awaiting_validation')
                # Không replay switch cùng session sau lỗi hoặc sau thành công.
                with self.assertRaisesRegex(RuntimeError,'release_already_started'):
                    r.switch(request)
                self.assertEqual(r.recover(request)['status'],'recovered_original_awaiting_user_validation')
                self.assertEqual(docker.probe(docker.manifest),docker.expected)
                self.assertEqual(len(docker.containers),3)
                # Recovery đọc trạng thái thật nên có thể tiếp tục sau mất phản hồi riêng.
                self.assertEqual(r.recover(request)['status'],'recovered_original_awaiting_user_validation')

    def test_recover_after_stop_response_lost(self): self.exercise('stop')
    def test_recover_after_rename_response_lost(self): self.exercise('rename')
    def test_recover_after_disconnect_response_lost(self): self.exercise('disconnect')
    def test_recover_after_create_response_lost(self): self.exercise('create')
    def test_recover_after_start_response_lost(self): self.exercise('start')
    def test_recover_after_health_response_lost(self): self.exercise('health')
    def test_recover_partial_second_api(self): self.exercise('start',1)
    def test_recover_all_apis_when_pages_publish_fails(self): self.exercise(None)

    def test_new_exam_during_drain_blocks_candidate_and_can_restore(self):
        docker = DockerFixture()
        request = {'manifest':docker.manifest,'expected':docker.expected,'run_id':'1'*32}
        with tempfile.TemporaryDirectory() as directory,patch.object(r,'RELEASE_ROOT',Path(directory)),patch.object(r,'probe',docker.probe),patch.object(r,'inspect',docker.inspect),patch.object(r,'api',docker.api),patch.object(r,'wait_healthy',docker.healthy),patch.object(r,'active_writing',return_value=[{'active':0}]),patch.object(r,'verify_backup',return_value={}),patch.object(r,'image_hashes',return_value={}),patch.object(r,'stopped_activity',return_value={'active':1}),patch.object(r,'write_receipt',side_effect=lambda path,value:path.write_text(json.dumps(value),encoding='utf-8')):
            with self.assertRaisesRegex(RuntimeError,'exam_started_during_drain'):
                r.switch(request)
            self.assertEqual(len(docker.containers),3)
            self.assertTrue(all(not item['State']['Running'] for item in docker.containers.values()))
            with self.assertRaisesRegex(RuntimeError,'recovery_blocked_active_exam'):
                r.recover(request)
            with patch.object(r,'stopped_activity',return_value={'active':0}):
                self.assertEqual(r.recover(request)['status'],'recovered_original_awaiting_user_validation')
            self.assertEqual(docker.probe(docker.manifest),docker.expected)

    def test_forced_shutdown_blocks_before_candidate_creation(self):
        docker = DockerFixture()
        original_api = docker.api
        def force_shutdown(method,url,body=None):
            result = original_api(method,url,body)
            if '/stop?' in url and not getattr(docker,'forced_once',False):
                docker.forced_once=True
                identifier = url.split('/')[2]
                docker.containers[identifier]['State']['ExitCode'] = 1
            return result
        request = {'manifest':docker.manifest,'expected':docker.expected,'run_id':'1'*32}
        with tempfile.TemporaryDirectory() as directory,patch.object(r,'RELEASE_ROOT',Path(directory)),patch.object(r,'probe',docker.probe),patch.object(r,'inspect',docker.inspect),patch.object(r,'api',force_shutdown),patch.object(r,'stopped_activity',return_value={'active':0}),patch.object(r,'wait_healthy',docker.healthy),patch.object(r,'active_writing',return_value=[{'active':0}]),patch.object(r,'verify_backup',return_value={}),patch.object(r,'image_hashes',return_value={}),patch.object(r,'write_receipt',side_effect=lambda path,value:path.write_text(json.dumps(value),encoding='utf-8')):
            with self.assertRaisesRegex(RuntimeError,'graceful_drain_failed'):
                r.switch(request)
            self.assertEqual(len(docker.containers),3)
            self.assertEqual(r.recover(request)['status'],'recovered_original_awaiting_user_validation')
            self.assertEqual(docker.probe(docker.manifest),docker.expected)

    def test_recovery_new_exam_race_keeps_candidates_and_resumes_them(self):
        docker = DockerFixture()
        request = {'manifest':docker.manifest,'expected':docker.expected,'run_id':'1'*32}
        with tempfile.TemporaryDirectory() as directory,patch.object(r,'RELEASE_ROOT',Path(directory)),patch.object(r,'probe',docker.probe),patch.object(r,'inspect',docker.inspect),patch.object(r,'api',docker.api),patch.object(r,'wait_healthy',docker.healthy),patch.object(r,'active_writing',return_value=[{'active':0}]),patch.object(r,'verify_backup',return_value={}),patch.object(r,'image_hashes',return_value={}),patch.object(r,'stopped_activity',return_value={'active':0}),patch.object(r,'write_receipt',side_effect=lambda path,value:path.write_text(json.dumps(value),encoding='utf-8')):
            r.switch(request)
            candidates = docker.probe(docker.manifest)
            # Phiên thi xuất hiện sau lần đọc đầu và trước khi drain hoàn tất.
            with patch.object(r,'stopped_activity',side_effect=[{'active':0}]*3+[{'active':1}]+[{'active':0}]*2):
                with self.assertRaisesRegex(RuntimeError,'recovery_blocked_new_exam'):
                    r.recover(request)
            self.assertEqual(docker.probe(docker.manifest),candidates)
            self.assertEqual(len(docker.containers),6)

    def test_started_missing_deadline_cannot_be_ignored(self):
        sql = r.activity_sql('assessment')
        for skill in ('listening','reading','writing'):
            self.assertIn(skill+'_deadline_at IS NULL OR',sql)


class ArtifactContracts(unittest.TestCase):
    def archive(self, directory, wrong_layer=False):
        layer = b'fixture layer only'
        config = json.dumps({'rootfs':{'diff_ids':['sha256:'+hashlib.sha256(layer).hexdigest()]}},sort_keys=True).encode()
        config_name = hashlib.sha256(config).hexdigest()+'.json'
        manifest = json.dumps([{'Config':config_name,'Layers':['layer/layer.tar']}]).encode()
        path = Path(directory)/'fixture.tar.gz'
        with tarfile.open(path,'w:gz') as archive:
            for name,body in [(config_name,config),('layer/layer.tar',b'changed' if wrong_layer else layer),('manifest.json',manifest)]:
                member = tarfile.TarInfo(name);member.size=len(body);archive.addfile(member,io.BytesIO(body))
        return path,'sha256:'+hashlib.sha256(config).hexdigest()

    def test_archive_correct_config_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            path,image = self.archive(directory)
            self.assertTrue(r.archive_receipt(path,image)['config_and_layers_verified'])

    def test_archive_wrong_image_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            path,_ = self.archive(directory)
            with self.assertRaisesRegex(RuntimeError,'image_id_mismatch'):
                r.archive_receipt(path,'sha256:wrong')

    def test_archive_layer_corruption_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            path,image = self.archive(directory,True)
            with self.assertRaisesRegex(RuntimeError,'layer_digest_mismatch'):
                r.archive_receipt(path,image)

    def test_backup_file_corruption_is_rechecked_before_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            run_id = '1'*32
            root = Path(directory)/run_id
            root.mkdir()
            file,image = self.archive(root)
            renamed = root/'api-fixture.image.tar.gz'
            file.rename(renamed)
            receipt = r.archive_receipt(renamed,image)
            manifest = {'targets':[{'name':'api-fixture','base_image':image}]}
            (root/'receipt.json').write_text(json.dumps({'status':'passed','before':[],'images':[{'target':'api-fixture',**receipt}]}),encoding='utf-8')
            request = {'run_id':run_id,'expected':[],'manifest':manifest}
            with patch.object(r,'BACKUP_ROOT',Path(directory)):
                self.assertEqual(r.verify_backup(request)['status'],'passed')
                with renamed.open('ab') as stream:
                    stream.write(b'corrupt-trailer')
                with self.assertRaises((RuntimeError,tarfile.ReadError,OSError)):
                    r.verify_backup(request)

    def test_target_missing_duplicate_or_reordered_blocks(self):
        baseline = {'targets':[{'name':name} for name in ('a','b','c')]}
        for names in [('a','b'),('a','b','b'),('a','c','b')]:
            with self.assertRaisesRegex(RuntimeError,'target_set'):
                a.validate_target_set({'targets':[{'name':name} for name in names]},baseline)

    def test_mixed_runtime_never_maps_latest_head(self):
        targets = [{'name':name,'base_image':'base','candidate_image':'candidate'} for name in ('a','b','c')]
        manifest = {'targets':targets,'baseline_checkpoint':'fixed-base'}
        rows = [{'name':name,'image':image,'config_hash':'fixture','source_hash':'fixture','running':True,'healthy':'healthy'} for name,image in [('a','candidate'),('b','base'),('c','base')]]
        with patch.object(a.Path,'read_text',return_value=json.dumps(manifest)),patch.object(a,'checkpoint_inputs',return_value='fixed-candidate'),patch.object(a,'pages_live') as pages:
            with self.assertRaisesRegex(RuntimeError,'mixed_runtime_recovery_required'):
                a.snapshots({},rows)
            pages.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
