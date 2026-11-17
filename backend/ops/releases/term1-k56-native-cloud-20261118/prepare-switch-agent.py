from pathlib import Path
import json,re,subprocess,os,time
ROOT=Path('/opt/izone-term1-k56-native-cloud-20261118')
stage=json.loads((ROOT/'stage-agent.json').read_text())
source=Path('/opt/izone-mini-k67-paper-native-cloud-20261117/switch-agent.py').read_text()
values={'ROOT':"Path('/opt/izone-term1-k56-native-cloud-20261118')",
 'STAGED':repr('izone-log-drive-k67-v1-term1-k56-native-staged-20261118'),
 'PREVIOUS':repr('izone-log-drive-k67-v1-before-term1-k56-native-20261118'),
 'LIVE_ID':repr(stage['oldAgent']),'STAGED_ID':repr(stage['newAgent']),
 'NGINX_SHA':repr(stage['nginxSha256']),'CANDIDATE_NGINX_SHA':repr(stage['candidateNginxSha256']),
 'CANDIDATE_CONFIG_SHA':repr(stage['candidateConfigSha256']),'CANDIDATE_CODE_SHA':repr(stage['candidateCodeSha256']),
 'NEW_PRODUCT':repr('term-mini-k56-term1-cbt-cloud')}
for key,value in values.items():
 source,count=re.subn('^'+key+r' = .+$',key+' = '+value,source,count=1,flags=re.MULTILINE);assert count==1,key
compile(source,str(ROOT/'switch-agent.py'),'exec')
with (ROOT/'switch-agent.py').open('x') as output:output.write(source)
service=Path('/etc/systemd/system/izone-term2-k56-native-journal-forwarder.service').read_text()
service=service.replace('/opt/izone-term2-k56-native-cloud-20261117',str(ROOT)).replace('Term Test 2 K56','Term Test 1 K56')
public=Path('/opt/izone-term1-k56-native-forwarder-20261118')
public.mkdir(mode=0o755)
for name in ['native-agent-forwarder.mjs','forwarder-core.mjs']:
 with (public/name).open('xb') as output:output.write((ROOT/name).read_bytes())
 os.chmod(public/name,0o644)
service=service.replace(str(ROOT),str(public))
path=Path('/etc/systemd/system/izone-term1-k56-native-journal-forwarder.service')
with path.open('x') as output:output.write(service)
os.chmod(path,0o644)
subprocess.run(['systemd-analyze','verify',str(path)],check=True,timeout=15)
subprocess.run(['systemctl','daemon-reload'],check=True,timeout=15)
subprocess.run(['systemctl','enable','--now',path.name],check=True,timeout=15)
assert subprocess.check_output(['systemctl','is-active',path.name],timeout=10).strip()==b'active'
for _ in range(20):
 if subprocess.check_output(['ss','-H','-ltn','sport = :13989'],timeout=10).strip():break
 time.sleep(.2)
assert subprocess.check_output(['ss','-H','-ltn','sport = :13989'],timeout=10).strip()
print(json.dumps({'stagedAgent':stage['newAgent'],'forwarderPort':13989,'service':path.name,'trafficSwitched':False}))
