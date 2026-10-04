"""Gói phát hành D08: nhận cấu hình riêng đã khóa trong plan.
Đọc Git/image/site thật, sao lưu, kiểm cổng, rồi chuyển đúng artifact đã duyệt.
Lỗi giữ biên nhận và trả nonzero; không tự phát hành lại sau mất phản hồi.
"""
from __future__ import annotations
import argparse,datetime,hashlib,importlib.util,json,os,re,shlex,subprocess,sys,time,urllib.request
from pathlib import Path
HERE=Path(__file__).resolve().parent
BACKEND=HERE.parents[3]
def sha(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def command(argv,cwd=None,timeout=120):
 result=subprocess.run(argv,cwd=cwd,capture_output=True,text=True,encoding='utf-8',timeout=timeout)
 if result.returncode:raise RuntimeError('command_failed:'+Path(argv[0]).name+':'+str(result.returncode))
 return result.stdout.strip()
def head(repo):return command(['git','rev-parse','HEAD'],repo)
def remote(config,action):
 spec=importlib.util.spec_from_file_location('ssh_credentials',HERE/'ssh_credentials.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 client,password=helper.connect('vps_1');password=''
 try:
  manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'));baseline=json.loads((HERE/'baseline.json').read_text(encoding='utf-8'))
  validate_target_set(manifest,baseline)
  for target,base in zip(manifest['targets'],baseline['targets']):
   if target['name']!=base['name']:raise RuntimeError('manifest_order_mismatch')
   target['baseline_hashes']=base['source_hashes'];target['schema']='assessment_k56' if target['name']=='izone-k56-ic2264-api' else 'assessment'
  request={'action':action,'manifest':manifest,'run_id':config['run_id'],'expected':config.get('api_before')}
  script=(HERE/'release_remote.py').read_text(encoding='utf-8')
  stdin,stdout,stderr=client.exec_command('python3 -c '+shlex.quote(script),timeout=900)
  stdin.write(json.dumps(request));stdin.channel.shutdown_write();raw=stdout.read().decode('utf-8');stderr.read();code=stdout.channel.recv_exit_status()
  if not raw:raise RuntimeError('remote_no_response_unknown')
  value=json.loads(raw)
  if code:raise RuntimeError('remote_failed:'+str(value.get('error','unknown')))
  return value
 finally:client.close()
def pages_live(config):
 repo=Path(config['pages_repo']);name='tranhoangduc90/izone-ai-team-pages'
 latest=json.loads(command(['gh','api','repos/'+name+'/pages/builds/latest']))
 if latest['status']!='built':raise RuntimeError('pages_build_not_complete')
 revision=latest['commit'];tree=command(['git','rev-parse',revision+'^{tree}'],repo)
 manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
 if revision not in (config['pages_before_commit'],manifest['pages_candidate']):raise RuntimeError('pages_live_commit_outside_package')
 return {'revision':revision,'fingerprint':sha({'tree':tree,'nojekyll':True}),'sources':{'pages':revision}}
def validate_target_set(manifest, baseline):
 # Nhận hai manifest; chặn thiếu, trùng hoặc đổi thứ tự đích trước mọi lệnh từ xa.
 names = [item['name'] for item in manifest['targets']]
 base_names = [item['name'] for item in baseline['targets']]
 if len(names) != 3 or len(set(names)) != 3 or names != base_names:
  raise RuntimeError('manifest_target_set_mismatch')

def checkpoint_inputs(config, manifest):
 # Commit cố định là mốc nhập artifact, không phải bằng chứng original build Git.
 checkpoint = config.get('candidate_checkpoint')
 if not isinstance(checkpoint,str) or re.fullmatch(r'[0-9a-f]{40}',checkpoint) is None:
  raise RuntimeError('candidate_checkpoint_missing')
 prefix = HERE.relative_to(BACKEND).as_posix() + '/'
 if command(['git','status','--porcelain','--untracked-files=all'],BACKEND):
  raise RuntimeError('candidate_repository_not_clean')
 tree = subprocess.run(['git','ls-tree','-rz','--name-only',checkpoint,'--',prefix],cwd=BACKEND,capture_output=True,timeout=30)
 if tree.returncode:
  raise RuntimeError('checkpoint_tree_unavailable')
 files = [name.decode('utf-8')[len(prefix):] for name in tree.stdout.split(b'\0') if name]
 if not {'candidate.json','baseline.json','release_adapter.py','release_remote.py','ssh_credentials.py'}.issubset(files):
  raise RuntimeError('checkpoint_required_inputs_missing')
 for filename in files:
  original = subprocess.run(['git','show',checkpoint+':'+prefix+filename],cwd=BACKEND,capture_output=True,timeout=30)
  if original.returncode or original.stdout.replace(b'\r\n',b'\n') != (HERE/filename).read_bytes().replace(b'\r\n',b'\n'):
   raise RuntimeError('checkpoint_input_mismatch:'+filename)
 baseline = subprocess.run(['git','show',manifest['baseline_checkpoint']+':'+prefix+'baseline.json'],cwd=BACKEND,capture_output=True,timeout=30)
 if baseline.returncode or baseline.stdout.replace(b'\r\n',b'\n') != (HERE/'baseline.json').read_bytes().replace(b'\r\n',b'\n'):
  raise RuntimeError('baseline_checkpoint_manifest_changed')
 command(['git','merge-base','--is-ancestor',manifest['baseline_checkpoint'],checkpoint],BACKEND)
 if head(BACKEND) != checkpoint:
  raise RuntimeError('candidate_checkpoint_not_current_head')
 return checkpoint

def snapshots(config,rows=None):
 manifest = json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
 baseline = json.loads((HERE/'baseline.json').read_text(encoding='utf-8'))
 validate_target_set(manifest,baseline)
 checkpoint = checkpoint_inputs(config,manifest)
 rows = rows if rows is not None else remote(config,'probe')
 if [item['name'] for item in rows] != [item['name'] for item in manifest['targets']]:
  raise RuntimeError('runtime_target_set_mismatch')
 if any(not item['running'] or item['healthy'] != 'healthy' for item in rows):
  raise RuntimeError('api_not_healthy')
 stable = [{key:item[key] for key in ('name','image','config_hash','source_hash')} for item in rows]
 all_base = all(item['image'] == target['base_image'] for item,target in zip(rows,manifest['targets']))
 all_candidate = all(item['image'] == target['candidate_image'] for item,target in zip(rows,manifest['targets']))
 if not all_base and not all_candidate:
  raise RuntimeError('mixed_runtime_recovery_required')
 source = manifest['baseline_checkpoint'] if all_base else checkpoint
 api_snapshot = {'revision':sha([item['image'] for item in rows]),'fingerprint':sha(stable),'sources':{'backend':source}}
 return {'api.classroom':api_snapshot,'database.mapping':api_snapshot,'pages.ielts':pages_live(config)}
def public_readback(config):
 repo=Path(config['pages_repo']);manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'));expected=manifest['pages_candidate'];receipt=[]
 actual=pages_live(config)
 if actual['revision']!=expected:raise RuntimeError('published_commit_mismatch')
 for file in config['pages_assets']:
  source=subprocess.run(['git','show',expected+':'+file],cwd=repo,capture_output=True,timeout=30)
  if source.returncode:raise RuntimeError('source_asset_unavailable')
  url='https://tranhoangduc90.github.io/izone-ai-team-pages/'+file+'?d08='+expected[:12]
  request=urllib.request.Request(url,headers={'Cache-Control':'no-cache'})
  with urllib.request.urlopen(request,timeout=30) as response:body=response.read();status=response.status
  normalize=lambda b:b.replace(b'\r\n',b'\n')
  if status!=200 or normalize(body)!=normalize(source.stdout):raise RuntimeError('public_asset_mismatch:'+file)
  receipt.append({'path':file,'status':status,'sha256':hashlib.sha256(normalize(body)).hexdigest()})
 return {'status':'passed','commit':expected,'assets':receipt}
def backup(config):
 result=remote(config,'backup');repo=Path(config['pages_repo']);dest=Path(config['evidence_dir']);dest.mkdir(parents=True,exist_ok=True)
 bundle=dest/'pages-before.bundle'
 if bundle.exists():raise RuntimeError('backup_already_exists_reconcile')
 command(['git','bundle','create',str(bundle),config['pages_before_commit']],repo)
 command(['git','bundle','verify',str(bundle)],repo)
 return {'status':'passed','api':result,'pages_bundle':str(bundle)}
def validate(config):
 # Biên nhận các suite thuộc đúng image/tree đã chốt; checker không thay assertion.
 result=command([sys.executable,config['quality_checker'],config['quality_manifest'],'--current-revision',config['product_revision']],timeout=120)
 value=json.loads(result)
 if value.get('outcome')!='pass':raise RuntimeError('quality_gate_not_passed')
 dry=remote(config,'dry_create')
 return {'status':'passed','quality':value,'dry_create':dry}
def deploy(config):
 repo=Path(config['pages_repo']);manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
 expected=manifest['pages_candidate']
 live_main=command(['git','ls-remote','origin','refs/heads/main'],repo).split()[0]
 if live_main!=config['pages_before_commit']:raise RuntimeError('pages_main_changed_new_plan_required')
 command(['git','merge-base','--is-ancestor',live_main,expected],repo)
 result=remote(config,'switch')
 # Chỉ đẩy commit đã kiểm vào main; không pull/merge/squash phát sinh source chưa duyệt.
 command(['git','push','origin',expected+':refs/heads/main'],repo,timeout=180)
 deadline=time.monotonic()+600
 while time.monotonic()<deadline:
  try:
   value=pages_live(config)
   if value['revision']==expected:break
  except RuntimeError:pass
  time.sleep(5)
 else:raise RuntimeError('pages_publish_unknown_reconcile_do_not_replay')
 return {'status':'deployed_awaiting_validation','api':result,'pages':public_readback(config)}
def verify(config):
 # User-visible acceptance phải có canary/API/DB/UI và cleanup đọc lại, không chỉ HTTP200.
 actual=snapshots(config);public=public_readback(config)
 receipt=Path(config['evidence_dir'])/'production-user-outcome.json'
 if not receipt.exists():return {'status':'unknown','evidence_reference':str(receipt)}
 value=json.loads(receipt.read_text(encoding='utf-8'))
 spec=importlib.util.spec_from_file_location('outcome_receipt',HERE/'outcome_receipt.py')
 checker=importlib.util.module_from_spec(spec);spec.loader.exec_module(checker)
 manifest=json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
 try:
  checked=checker.validate(value,config,actual,public,receipt.parent,manifest)
 except (ValueError,KeyError,TypeError,OSError) as error:
  return {'status':'unknown','evidence_reference':str(receipt),'reason':str(error)}
 return {**checked,'evidence_reference':str(receipt)}
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('action',choices=['probe','inspect','dry_create','backup','validate','deploy','verify']);args=parser.parse_args();config=json.loads(Path(args.config).read_text(encoding='utf-8'))
 if args.action=='probe':value=snapshots(config)
 elif args.action=='inspect':value=remote(config,'probe')
 elif args.action=='dry_create':value=remote(config,'dry_create')
 else:value=globals()[args.action](config)
 print(json.dumps(value,ensure_ascii=False))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
 try:main()
 except Exception as exc:print(json.dumps({'status':'failed','error':str(exc)},ensure_ascii=False));sys.exit(1)
