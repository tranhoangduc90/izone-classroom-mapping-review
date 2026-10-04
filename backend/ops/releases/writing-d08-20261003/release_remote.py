"""Đọc image/config và tạo bản thử đã dừng; không tự chuyển production.
Dữ liệu vào: manifest và action JSON qua stdin. Kiểm image, source và cấu hình;
trả dấu kiểm không secret. Khi lệch, dừng trước thao tác live.
"""
from __future__ import annotations
import copy,hashlib,http.client,json,socket,subprocess,sys,uuid
from urllib.parse import quote

def digest(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
class UnixHTTP(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(self.timeout);self.sock.connect('/var/run/docker.sock')
def api(method,path,body=None):
 connection=UnixHTTP('localhost',timeout=120)
 try:
  connection.request(method,'/v1.47'+path,body=None if body is None else json.dumps(body),headers={'Content-Type':'application/json'})
  response=connection.getresponse();raw=response.read()
  if response.status not in (200,201,204,304):raise RuntimeError('docker_api_failed_'+str(response.status))
  return json.loads(raw) if raw else None
 finally:connection.close()
def inspect(name):return api('GET','/containers/'+quote(name,safe='')+'/json')
def mount_view(mounts):
 return sorted([{k:m.get(k) for k in ('Type','Source','Destination','Mode','RW','Propagation')} for m in mounts],key=lambda x:x['Destination'])
def host_view(host):
 result=copy.deepcopy(host)
 # Docker trả null ở container cũ, false khi create; cả hai bật OOM killer mặc định.
 result['OomKillDisable']=bool(result.get('OomKillDisable'))
 return result
def config_view(container):
 config=copy.deepcopy(container['Config']);config.pop('Image',None)
 env=config.pop('Env',[]);config['env_hash']=digest(sorted(env))
 return {'config':config,'host':host_view(container['HostConfig']),'mounts':mount_view(container['Mounts']),'networks':{name:{'aliases':sorted(a for a in (entry.get('Aliases') or []) if a not in (container['Id'],container['Id'][:12])),'ipam':entry.get('IPAMConfig'),'links':entry.get('Links')} for name,entry in sorted(container['NetworkSettings']['Networks'].items())}}
def image_hashes(image,paths):
 # Container không có network/Env production; chỉ đọc file, không gọi server.
 code="const f=require('fs'),h=require('crypto'),r={};for(const p of JSON.parse(process.argv[1]))r[p]=h.createHash('sha256').update(f.readFileSync('/app/'+p)).digest('hex');console.log(JSON.stringify(r));"
 run=subprocess.run(['docker','run','--rm','--network','none','--entrypoint','node',image,'-e',code,json.dumps(sorted(paths))],capture_output=True,text=True,timeout=120)
 if run.returncode:raise RuntimeError('image_source_read_failed')
 return json.loads(run.stdout)
def create_payload(old,image,dry=False):
 body=copy.deepcopy(old['Config']);body['Image']=image
 host=host_view(old['HostConfig'])
 # Chỉ nhận mount khai báo rõ; không tạo lại volume dữ liệu vô danh.
 destinations={x['Destination'] for x in old['Mounts']}
 for mount in old['Mounts']:
  if mount['Type'] not in ('bind','tmpfs'):raise RuntimeError('persistent_volume_requires_explicit_review')
 if any(x.get('IPAMConfig') or x.get('Links') for x in old['NetworkSettings']['Networks'].values()):raise RuntimeError('static_network_requires_explicit_review')
 networks={}
 for name,entry in old['NetworkSettings']['Networks'].items():
  aliases=[a for a in (entry.get('Aliases') or []) if a not in (old['Id'],old['Id'][:12])]
  networks[name]={'Aliases':aliases}
 if dry:
  host['NetworkMode']='none';networks={}
 body['HostConfig']=host;body['NetworkingConfig']={'EndpointsConfig':networks}
 return body
def probe(manifest):
 rows=[]
 for target in manifest['targets']:
  old=inspect(target['name']);image=old['Image']
  baseline=target['base_image'];candidate=target['candidate_image']
  if image not in (baseline,candidate):raise RuntimeError('live_image_not_in_manifest')
  expected=target['source_hashes'] if image==candidate else target['baseline_hashes']
  actual=image_hashes(image,expected)
  if actual!=expected:raise RuntimeError('live_source_hash_mismatch')
  rows.append({'name':target['name'],'image':image,'config_hash':digest(config_view(old)),'source_hash':digest(actual),'healthy':old['State'].get('Health',{}).get('Status'),'running':old['State']['Running'],'restart_count':old['RestartCount'],'container_id':old['Id']})
 return rows
def dry_create(manifest):
 before=probe(manifest);receipts=[]
 for target in manifest['targets']:
  actual=image_hashes(target['candidate_image'],target['source_hashes'])
  if actual!=target['source_hashes']:raise RuntimeError('candidate_source_hash_mismatch')
  old=inspect(target['name']);name='izone-d08-shadow-'+uuid.uuid4().hex;created=None
  try:
   body=create_payload(old,target['candidate_image'],True)
   created=api('POST','/containers/create?name='+name,body)['Id'];shadow=inspect(created)
   if shadow['State']['Running']:raise RuntimeError('shadow_started_unexpectedly')
   expected=copy.deepcopy(old['Config']);expected['Image']=target['candidate_image']
   if shadow['Config']!=expected:raise RuntimeError('clone_config_mismatch')
   expected_host=host_view(old['HostConfig']);expected_host['NetworkMode']='none'
   if host_view(shadow['HostConfig'])!=expected_host:
    keys=[k for k in set(shadow['HostConfig'])|set(expected_host) if shadow['HostConfig'].get(k)!=expected_host.get(k)]
    raise RuntimeError('clone_host_config_mismatch:'+','.join(sorted(keys)))
   if mount_view(shadow['Mounts'])!=mount_view(old['Mounts']):raise RuntimeError('clone_mount_mismatch')
   receipts.append({'target':target['name'],'status':'passed','shadow_started':False,'config_equal':True,'mounts_equal':True,'network_payload_checked':bool(create_payload(old,target['candidate_image'])['NetworkingConfig']['EndpointsConfig'])})
  finally:
   if created:
    item=inspect(created)
    if item['Name']!='/'+name or item['State']['Running']:raise RuntimeError('shadow_cleanup_guard_failed')
    api('DELETE','/containers/'+created+'?v=true')
 if probe(manifest)!=before:raise RuntimeError('live_changed_during_dry_preflight')
 return {'status':'passed','targets':receipts,'live_unchanged':True,'cleanup':'verified'}

# Biên nhận bền vững ghi trước mỗi bước; mất phản hồi không được chạy switch lần hai.
from pathlib import Path
import os,time,gzip,datetime,tarfile
def write_receipt(path,value):
 path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 temporary=path.with_suffix('.new')
 with temporary.open('w',encoding='utf-8') as stream:
  json.dump(value,stream,ensure_ascii=False,indent=2);stream.flush();os.fsync(stream.fileno())
 os.chmod(temporary,0o600);os.replace(temporary,path)
 # fsync thư mục giữ việc rename biên nhận khi máy mất điện.
 directory_fd=os.open(path.parent,os.O_RDONLY)
 try:os.fsync(directory_fd)
 finally:os.close(directory_fd)
def checked_run_id(value):
 if uuid.UUID(value).hex!=value:raise RuntimeError('run_id_invalid')
 return value
BACKUP_ROOT = Path('/opt/izone-writing-d08-fix-20261003/backups')
RELEASE_ROOT = Path('/opt/izone-writing-d08-fix-20261003/releases')

def archive_receipt(file, expected_image):
 # Nhận Docker save tar.gz; đọc trọn tar, xác minh config ID và từng layer.
 # Không extract, không chạy image, không nạp credential hoặc dữ liệu production.
 file = Path(file)
 checksum = hashlib.sha256()
 with file.open('rb') as stream:
  while block := stream.read(1024*1024):
   checksum.update(block)
 names = set()
 content_hashes = {}
 small_json = {}
 total = 0
 with tarfile.open(file,mode='r|gz') as archive:
  for member in archive:
   if member.name in names or member.name.startswith('/') or '..' in Path(member.name).parts:
    raise RuntimeError('backup_archive_unsafe_member')
   names.add(member.name)
   if not member.isfile():
    continue
   stream = archive.extractfile(member)
   digest_value = hashlib.sha256()
   json_bytes = bytearray()
   capture = member.name == 'manifest.json' or member.name.endswith('.json') or member.name.startswith('blobs/sha256/') and member.size < 1024*1024
   while block := stream.read(1024*1024):
    digest_value.update(block)
    total += len(block)
    if capture and len(json_bytes) <= 16*1024*1024:
     json_bytes.extend(block)
   content_hashes[member.name] = digest_value.hexdigest()
   if capture and len(json_bytes) <= 16*1024*1024:
    try:small_json[member.name] = json.loads(json_bytes)
    except (UnicodeDecodeError,json.JSONDecodeError):pass
 manifest = small_json.get('manifest.json')
 if not isinstance(manifest,list) or len(manifest) != 1:
  raise RuntimeError('backup_archive_manifest_invalid')
 item = manifest[0]
 config_name = item.get('Config')
 if 'sha256:'+content_hashes.get(config_name,'') != expected_image:
  raise RuntimeError('backup_archive_image_id_mismatch')
 config = small_json.get(config_name,{})
 layers = item.get('Layers')
 diff_ids = config.get('rootfs',{}).get('diff_ids')
 if not isinstance(layers,list) or not isinstance(diff_ids,list) or len(layers) != len(diff_ids) or not layers:
  raise RuntimeError('backup_archive_layers_invalid')
 for layer,expected in zip(layers,diff_ids):
  if 'sha256:'+content_hashes.get(layer,'') != expected:
   raise RuntimeError('backup_archive_layer_digest_mismatch')
 return {'file':str(file),'image':expected_image,'sha256':checksum.hexdigest(),'uncompressed_bytes':total,'layer_count':len(layers),'config_and_layers_verified':True}

def verify_backup(request):
 # Biên nhận đã lưu không thay thế file thật: đọc lại archive ngay trước stop.
 expected = request['expected']
 directory = BACKUP_ROOT / checked_run_id(request['run_id'])
 receipt = json.loads((directory/'receipt.json').read_text(encoding='utf-8'))
 targets = request['manifest']['targets']
 if receipt.get('status') != 'passed' or receipt.get('before') != expected:
  raise RuntimeError('backup_receipt_mismatch')
 if [item['target'] for item in receipt.get('images',[])] != [item['name'] for item in targets]:
  raise RuntimeError('backup_target_set_mismatch')
 for target,saved in zip(targets,receipt['images']):
  file = directory/(target['name']+'.image.tar.gz')
  if Path(saved['file']).resolve() != file.resolve():
   raise RuntimeError('backup_path_mismatch')
  actual = archive_receipt(file,target['base_image'])
  if any(saved.get(key) != value for key,value in actual.items()):
   raise RuntimeError('backup_file_changed_or_invalid')
 return receipt

def backup(request):
 manifest = request['manifest']
 actual = probe(manifest)
 if actual != request['expected']:
  raise RuntimeError('backup_live_drift')
 directory = BACKUP_ROOT/checked_run_id(request['run_id'])
 directory.mkdir(mode=0o700,parents=True,exist_ok=False)
 images = []
 for target in manifest['targets']:
  image = target['base_image']
  file = directory/(target['name']+'.image.tar.gz')
  # Chỉ lưu image nền; Env vẫn giữ riêng trong container gốc để hoàn nguyên.
  with gzip.open(file,'wb',compresslevel=1) as stream:
   process = subprocess.Popen(['docker','image','save',image],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
   while block := process.stdout.read(1024*1024):
    stream.write(block)
   if process.wait() != 0:
    raise RuntimeError('image_backup_failed')
  os.chmod(file,0o600)
  images.append({'target':target['name'],**archive_receipt(file,image)})
 result = {'status':'passed','before':actual,'images':images,'path':str(directory),'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 write_receipt(directory/'receipt.json',result)
 verify_backup(request)
 if probe(manifest) != actual:
  raise RuntimeError('backup_live_drift_after')
 return {'status':'passed','evidence_reference':str(directory/'receipt.json')}
def activity_sql(schema):
 # Đếm mọi phần thi và khoảng nộp bù 5 phút, không đọc tên/bài học viên.
 if schema not in ('assessment','assessment_k56'):
  raise RuntimeError('schema_not_allowed')
 return """SELECT json_build_object(
  'listening',(SELECT count(*)::int FROM {schema}.term_test_exam_session
   WHERE superseded_at IS NULL AND listening_started_at IS NOT NULL
    AND listening_submitted_at IS NULL
    AND (listening_deadline_at IS NULL OR listening_deadline_at + interval '5 minutes' > clock_timestamp())),
  'reading',(SELECT count(*)::int FROM {schema}.term_test_attempt
   WHERE superseded_at IS NULL AND reading_started_at IS NOT NULL
    AND reading_submitted_at IS NULL
    AND (reading_deadline_at IS NULL OR reading_deadline_at + interval '5 minutes' > clock_timestamp())),
  'writing',(SELECT count(*)::int FROM {schema}.term_test_attempt
   WHERE superseded_at IS NULL AND writing_started_at IS NOT NULL
    AND writing_submitted_at IS NULL
    AND (writing_deadline_at IS NULL OR writing_deadline_at + interval '5 minutes' > clock_timestamp()))
 ) AS activity""".format(schema=schema)

def activity_code(target):
 sql = activity_sql(target['schema'])
 expected_database = 'izone_mapping_demo' if target['name']=='izone-k56-demo-k56-demo-api-1' else 'mapping_db'
 return """import pg from 'pg';
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,application_name:'codex_d08_release_readonly'});
 try {
  await pool.query('BEGIN READ ONLY');
  await pool.query("SET LOCAL statement_timeout='10s'");
  const identity=await pool.query('SELECT current_database() AS name');
  if(identity.rows[0].name!==EXPECTED)throw new Error('database_destination_mismatch');
  const result=await pool.query(SQL);
  await pool.query('COMMIT');
  const activity=result.rows[0].activity;
  console.log(JSON.stringify({activity,active:Object.values(activity).reduce((a,b)=>a+b,0)}));
 } finally {await pool.end();}
 """.replace('EXPECTED',json.dumps(expected_database)).replace('SQL',json.dumps(sql))

def active_writing(manifest):
 # Tên hàm giữ compatibility; scope đã mở rộng cả Listening/Reading/Writing.
 rows=[]
 for target in manifest['targets']:
  run=subprocess.run(['docker','exec','-w','/app',target['name'],'node','--input-type=module','-e',activity_code(target)],capture_output=True,text=True,timeout=30)
  if run.returncode:
   raise RuntimeError('active_exam_read_failed')
  value=json.loads(run.stdout)
  rows.append({'target':target['name'],**value})
 return rows

def stopped_activity(target,old):
 # API cũ đã dừng nhận request. Helper riêng chỉ SELECT bằng đúng role/DB;
 # không chạy server/consumer, không mở cổng hoặc dùng DNS alias production.
 name='izone-d08-activity-'+uuid.uuid4().hex
 networks={network:{'Aliases':[]} for network in old['NetworkSettings']['Networks']}
 # Sau disconnect phải lấy network đã lưu trước stop từ target runtime tạm.
 if not networks:
  raise RuntimeError('activity_network_missing')
 body={'Image':old['Image'],'Env':old['Config']['Env'],'Entrypoint':['node'],
  'Cmd':['--input-type=module','-e',activity_code(target)],'WorkingDir':'/app',
  'Labels':{'codex.task':'writing-d08-activity'},'Healthcheck':{'Test':['NONE']},
  'HostConfig':{'NetworkMode':next(iter(networks)),'ReadonlyRootfs':True,
   'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'PidsLimit':64,'Memory':268435456},
  'NetworkingConfig':{'EndpointsConfig':networks}}
 identifier=api('POST','/containers/create?name='+name,body)['Id']
 try:
  api('POST','/containers/'+identifier+'/start')
  result=api('POST','/containers/'+identifier+'/wait?condition=not-running')
  if result.get('StatusCode')!=0:
   raise RuntimeError('activity_readback_failed')
  output=subprocess.run(['docker','logs',identifier],capture_output=True,text=True,timeout=30)
  if output.returncode:
   raise RuntimeError('activity_log_read_failed')
  value=json.loads(output.stdout)
  if set(value)!= {'activity','active'} or set(value['activity']) != {'listening','reading','writing'} or any(type(number) is not int or number<0 for number in value['activity'].values()) or value['active']!=sum(value['activity'].values()):
   raise RuntimeError('activity_receipt_invalid')
  return {'target':target['name'],**value}
 finally:
  item=inspect(identifier)
  if item['Name']!='/'+name or item['Config'].get('Labels',{}).get('codex.task')!='writing-d08-activity':
   raise RuntimeError('activity_cleanup_identity_failed')
  if item['State']['Running']:
   api('POST','/containers/'+identifier+'/stop?t=15')
  api('DELETE','/containers/'+identifier+'?v=false')

def switch(request):
 manifest=request['manifest']
 expected=request['expected']
 run_id=checked_run_id(request['run_id'])
 path=RELEASE_ROOT/(run_id+'.json')
 if path.exists():
  raise RuntimeError('release_already_started_reconcile_receipt_do_not_replay')
 if probe(manifest)!=expected:
  raise RuntimeError('switch_live_drift')
 active=active_writing(manifest)
 if any(item['active']!=0 for item in active):
  raise RuntimeError('writing_in_progress_wait_for_window')
 verify_backup(request)
 for target in manifest['targets']:
  if image_hashes(target['candidate_image'],target['source_hashes'])!=target['source_hashes']:
   raise RuntimeError('candidate_source_hash_mismatch_before_stop')
 state={'status':'started','targets':[],'run_id':run_id,'before':expected,'active_before':active}
 write_receipt(path,state)
 try:
  # Dừng nhận request và đợi graceful shutdown trên cả ba API trước tạo candidate.
  # Nếu có phiên thi mới lọt vào trước stop, SELECT sau drain sẽ chặn và giữ bản cũ.
  for target in manifest['targets']:
   old=inspect(target['name'])
   original=next(item for item in expected if item['name']==target['name'])
   if old['Id']!=original['container_id'] or digest(config_view(old))!=original['config_hash']:
    raise RuntimeError('target_drift_before_stop')
   body=create_payload(old,target['candidate_image'])
   row={'name':target['name'],'old_id':old['Id'],'old_image':old['Image'],
    'old_config_hash':original['config_hash'],
    'old_core_hash':digest({key:value for key,value in config_view(old).items() if key!='networks'}),
    'backup_name':target['name']+'-d08-backup-'+run_id[:12],
    'endpoints':body['NetworkingConfig']['EndpointsConfig'],'phase':'before_stop'}
   state['targets'].append(row)
   write_receipt(path,state)
   api('POST','/containers/'+old['Id']+'/stop?t=30')
   stopped=inspect(old['Id'])
   if stopped['State']['Running'] or stopped['State'].get('ExitCode')!=0 or stopped['State'].get('OOMKilled'):
    raise RuntimeError('graceful_drain_failed_recovery_required')
   row['phase']='stopped'
   write_receipt(path,state)
  after_drain=[]
  for target,row in zip(manifest['targets'],state['targets']):
   after_drain.append(stopped_activity(target,inspect(row['old_id'])))
  state['activity_after_drain']=after_drain
  write_receipt(path,state)
  if any(item['active']!=0 for item in after_drain):
   raise RuntimeError('exam_started_during_drain_recovery_required')
  for target,row in zip(manifest['targets'],state['targets']):
   old=inspect(row['old_id'])
   body=create_payload(old,target['candidate_image'])
   row['phase']='before_rename'
   write_receipt(path,state)
   api('POST','/containers/'+old['Id']+'/rename?name='+quote(row['backup_name']))
   row['phase']='renamed'
   write_receipt(path,state)
   for network in row['endpoints']:
    row['phase']='before_disconnect:'+network
    write_receipt(path,state)
    api('POST','/networks/'+quote(network,safe='')+'/disconnect',{'Container':old['Id'],'Force':False})
   row['phase']='disconnected'
   write_receipt(path,state)
   new=api('POST','/containers/create?name='+quote(target['name']),body)['Id']
   row['new_id']=new
   row['phase']='created'
   write_receipt(path,state)
   item=inspect(new)
   if digest(config_view(item))!=row['old_config_hash'] or item['Image']!=target['candidate_image']:
    raise RuntimeError('created_configuration_mismatch_no_start')
   api('POST','/containers/'+new+'/start')
   row['phase']='started'
   write_receipt(path,state)
   wait_healthy(new)
   row['phase']='healthy'
   write_receipt(path,state)
  state['status']='deployed_awaiting_validation'
  state['after']=probe(manifest)
  write_receipt(path,state)
  return {'status':state['status'],'evidence_reference':str(path),'old_containers_retained':True}
 except Exception as error:
  # Không rollback hoặc retry ngầm. Wrapper giữ khóa; operator đọc journal và duyệt recover.
  state['status']='recovery_required'
  state['error']=str(error)
  write_receipt(path,state)
  raise

def optional_inspect(name):
 # Chỉ 404 là không tồn tại; timeout hoặc lỗi Docker không được coi là đã dọn.
 try:
  return inspect(name)
 except RuntimeError as error:
  if str(error) == 'docker_api_failed_404':
   return None
  raise

def recovery_activity(manifest,state):
 # Dùng đúng DB role của container gốc, kể cả khi tên/mạng đã đổi giữa pha.
 rows=[]
 for target in manifest['targets']:
  row=next((item for item in state['targets'] if item['name']==target['name']),None)
  old=inspect(row['old_id'] if row else target['name'])
  if row:
   core=digest({key:value for key,value in config_view(old).items() if key!='networks'})
   if old['Image']!=row['old_image'] or core!=row['old_core_hash']:
    raise RuntimeError('recovery_original_core_changed')
   old['NetworkSettings']['Networks']=row['endpoints']
  rows.append(stopped_activity(target,old))
 return rows

def recover(request):
 # Đầu vào là run ID đã có journal và snapshot trước chuyển; không replay switch.
 # Khôi phục container gốc đúng ID, cấu hình và mạng; dữ liệu DB không bị rollback.
 run_id = checked_run_id(request['run_id'])
 path = RELEASE_ROOT/(run_id+'.json')
 state = json.loads(path.read_text(encoding='utf-8'))
 if state.get('run_id') != run_id:
  raise RuntimeError('recovery_run_id_mismatch')
 expected = request['expected']
 if state.get('before',expected) != expected:
  raise RuntimeError('recovery_expected_snapshot_mismatch')
 manifest = request['manifest']
 targets = {item['name']:item for item in manifest['targets']}
 # Một candidate đã healthy có thể nhận bài trong lúc target khác hoặc Pages lỗi.
 # Không hạ về bản cũ khi có phiên mới: kiểm trước, drain, rồi kiểm lại cả ba DB.
 activity=recovery_activity(manifest,state)
 state['activity_before_recovery']=activity
 write_receipt(path,state)
 if any(item['active']!=0 for item in activity):
  raise RuntimeError('recovery_blocked_active_exam_no_downgrade')
 stopped=[]
 try:
  for target in manifest['targets']:
   current=optional_inspect(target['name'])
   if current and current['State']['Running']:
    original=next(item for item in expected if item['name']==target['name'])
    if current['Image'] not in (target['base_image'],target['candidate_image']) or digest(config_view(current))!=original['config_hash']:
     raise RuntimeError('recovery_running_identity_mismatch')
    stopped.append({'id':current['Id'],'image':current['Image'],'config_hash':original['config_hash']})
    state['recovery_stopped']=stopped
    write_receipt(path,state)
    api('POST','/containers/'+current['Id']+'/stop?t=30')
    item=inspect(current['Id'])
    if item['State']['Running'] or item['State'].get('ExitCode')!=0 or item['State'].get('OOMKilled'):
     raise RuntimeError('recovery_graceful_drain_failed_no_downgrade')
  activity=recovery_activity(manifest,state)
  state['activity_after_recovery_drain']=activity
  write_receipt(path,state)
  if any(item['active']!=0 for item in activity):
   raise RuntimeError('recovery_blocked_new_exam_no_downgrade')
 except Exception:
  # Hoàn nguyên thao tác drain của chính recovery; giữ nguyên mọi image và dữ liệu.
  # Không đổi sang baseline, không xóa candidate có khả năng đã nhận bài mới.
  for saved in stopped:
   item=inspect(saved['id'])
   if item['Image']!=saved['image'] or digest(config_view(item))!=saved['config_hash']:
    raise RuntimeError('recovery_resume_identity_mismatch')
   if not item['State']['Running']:
    api('POST','/containers/'+saved['id']+'/start')
   wait_healthy(saved['id'])
  state['status']='recovery_blocked_current_images_resumed'
  write_receipt(path,state)
  raise
 for row in reversed(state['targets']):
  original = next(item for item in expected if item['name'] == row['name'])
  target = targets[row['name']]
  old = optional_inspect(row['old_id'])
  if old is None or old['Image'] != original['image'] or old['Id'] != original['container_id']:
   raise RuntimeError('recovery_original_container_missing_or_changed')
  if old['Name'] not in ('/'+row['name'],'/'+row['backup_name']):
   raise RuntimeError('recovery_original_name_outside_package')
  if digest({key:value for key,value in config_view(old).items() if key!='networks'}) != row['old_core_hash']:
   raise RuntimeError('recovery_original_core_changed')
  current = optional_inspect(row['name'])
  if current and current['Id'] != old['Id']:
   # Mất phản hồi create vẫn tìm được đúng candidate qua tên và dấu cấu hình.
   if current['Image'] != target['candidate_image'] or digest(config_view(current)) != original['config_hash']:
    raise RuntimeError('recovery_candidate_identity_mismatch')
   if row.get('new_id') and current['Id'] != row['new_id']:
    raise RuntimeError('recovery_candidate_id_mismatch')
   row['recovery_phase'] = 'before_remove_candidate'
   write_receipt(path,state)
   if current['State']['Running']:
    raise RuntimeError('recovery_candidate_running_after_drain')
   # v=false: không xóa bind/data volume; chỉ bỏ container candidate thuộc run.
   api('DELETE','/containers/'+current['Id']+'?v=false')
  old = inspect(row['old_id'])
  if old['Name'] != '/'+row['name']:
   api('POST','/containers/'+old['Id']+'/rename?name='+quote(row['name']))
  # Inspect từng mạng giúp phục hồi cả trường hợp disconnect lỗi giữa vòng.
  old = inspect(row['old_id'])
  for network,endpoint in row['endpoints'].items():
   if network not in old['NetworkSettings']['Networks']:
    api('POST','/networks/'+quote(network,safe='')+'/connect',{'Container':old['Id'],'EndpointConfig':endpoint})
  old = inspect(row['old_id'])
  if digest(config_view(old)) != original['config_hash']:
   raise RuntimeError('recovery_original_configuration_mismatch_no_start')
  if not old['State']['Running']:
   api('POST','/containers/'+old['Id']+'/start')
  wait_healthy(old['Id'])
  row['recovery_phase'] = 'original_verified'
  write_receipt(path,state)
 # API chưa tới pha switch cũng đã được drain; khởi động lại đúng container gốc.
 for original in expected:
  item=inspect(original['container_id'])
  if item['Name']!='/'+original['name'] or item['Image']!=original['image'] or digest(config_view(item))!=original['config_hash']:
   raise RuntimeError('recovery_untouched_original_mismatch')
  if not item['State']['Running']:
   api('POST','/containers/'+item['Id']+'/start')
  wait_healthy(item['Id'])
 actual = probe(manifest)
 stable_keys = ('name','image','config_hash','source_hash','container_id','running','healthy')
 if [{key:item[key] for key in stable_keys} for item in actual] != [{key:item[key] for key in stable_keys} for item in expected]:
  raise RuntimeError('recovery_readback_mismatch')
 state['status'] = 'recovered_original_awaiting_user_validation'
 state['recovery_after'] = actual
 write_receipt(path,state)
 return {'status':'recovered_original_awaiting_user_validation','evidence_reference':str(path),'database_rollback':False}

def wait_healthy(container_id):
 deadline = time.monotonic()+240
 while time.monotonic() < deadline:
  item = inspect(container_id)
  health = item['State'].get('Health',{}).get('Status')
  if item['State']['Running'] and health == 'healthy':
   return
  if not item['State']['Running'] or health == 'unhealthy':
   raise RuntimeError('candidate_start_or_health_failed_recovery_required')
  time.sleep(2)
 raise RuntimeError('candidate_health_unknown_recovery_required')

def main():
 request=json.load(sys.stdin);action=request['action'];manifest=request['manifest']
 if action=='probe':result=probe(manifest)
 elif action=='dry_create':result=dry_create(manifest)
 elif action=='backup':result=backup(request)
 elif action=='switch':result=switch(request)
 elif action=='active_writing':result=active_writing(manifest)
 elif action=='recover':result=recover(request)
 else:raise RuntimeError('action_not_implemented_no_live_change')
 print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':
 try:main()
 except Exception as exc:
  print(json.dumps({'status':'failed','error':str(exc)},ensure_ascii=False));sys.exit(1)
