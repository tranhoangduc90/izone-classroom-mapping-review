"""Git thật trong repository C tạm: backup phải giữ đúng commit và đủ object.
Không gọi SSH hoặc remote thật, không ghi repo/source khác.
"""
import importlib.util,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True;sys.stdout.reconfigure(encoding='utf-8')
spec=importlib.util.spec_from_file_location('adapter_under_test',os.environ.get('D08_BACKUP_ADAPTER',str(Path(__file__).parent/'release_adapter.py')))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class BackupRealGit(unittest.TestCase):
 def test_backup_exact_pages_commit_is_restorable(self):
  with tempfile.TemporaryDirectory(prefix='d08-backup-real-git-',dir='C:/Codex-Data') as d:
   root=Path(d);repo=root/'repo';repo.mkdir();evidence=root/'evidence';evidence.mkdir()
   env={**os.environ,'GIT_AUTHOR_NAME':'Fixture','GIT_AUTHOR_EMAIL':'fixture@example.invalid','GIT_COMMITTER_NAME':'Fixture','GIT_COMMITTER_EMAIL':'fixture@example.invalid'}
   def git(*argv):return subprocess.check_output(['git','-C',str(repo),*argv],env=env,stderr=subprocess.PIPE).decode().strip()
   git('init');(repo/'index.html').write_text('<h1>D08 fixture</h1>',encoding='utf-8');git('add','index.html');git('commit','-m','fixture')
   before=git('rev-parse','HEAD');config={'evidence_dir':str(evidence),'pages_repo':str(repo),'pages_before_commit':before,'run_id':'d'*32}
   with patch.object(a,'remote',return_value={'status':'passed','evidence_reference':'fixture-image-backup'}):result=a.backup(config)
   self.assertEqual(result['status'],'passed');bundle=evidence/'pages-before.bundle'
   heads=git('bundle','list-heads',str(bundle)).splitlines();self.assertEqual(len(heads),1);self.assertEqual(heads[0].split()[0],before)
   restored=root/'restored';restored.mkdir()
   subprocess.run(['git','-C',str(restored),'init'],env=env,capture_output=True,check=True)
   reference=heads[0].split()[1]
   r=subprocess.run(['git','-C',str(restored),'fetch',str(bundle),reference],env=env,capture_output=True)
   self.assertEqual(r.returncode,0,r.stderr.decode());self.assertEqual(subprocess.check_output(['git','-C',str(restored),'show','FETCH_HEAD:index.html']).decode(),'<h1>D08 fixture</h1>')
   self.assertEqual(git('rev-parse','HEAD'),before)
if __name__=='__main__':unittest.main()
