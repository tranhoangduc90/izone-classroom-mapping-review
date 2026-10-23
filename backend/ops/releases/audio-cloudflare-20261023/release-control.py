"""Prepare/apply one reviewed Docker image overlay, preserving the live config.

Run on the server only after deployment approval. Default action is read-only
plan. Credentials are read from Docker in memory and are never printed or saved.
Database backup/functional canary remain separate release steps. Never restores DB.
"""
import argparse,copy,hashlib,http.client,json,socket,time,subprocess

class Docker:
    def call(self,method,path,body=None):
        class Unix(http.client.HTTPConnection):
            def connect(self):
                self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
                self.sock.settimeout(120);self.sock.connect('/var/run/docker.sock')
        conn=Unix('localhost',timeout=120)
        try:
            conn.request(method,'/v1.45'+path,None if body is None else json.dumps(body),{'Content-Type':'application/json'})
            r=conn.getresponse();data=r.read()
            if r.status>=300:raise RuntimeError('docker_operation_failed:'+method+':'+path+':'+str(r.status))
            return json.loads(data) if data else None
        finally:conn.close()
    def inspect(self,name):return self.call('GET','/containers/'+name+'/json')

def config_hash(state):
    return hashlib.sha256(json.dumps({k:state[k] for k in ['Config','HostConfig']},sort_keys=True).encode()).hexdigest()

def guard(state,expected):
    if state['Id']!=expected['id'] or state['Image']!=expected['image'] or config_hash(state)!=expected['configHash']:
        raise RuntimeError('live_changed_reinspect_and_rebuild')
    if state['State'].get('Health',{}).get('Status')!='healthy':raise RuntimeError('live_not_healthy')
    if state['HostConfig'].get('AutoRemove'):raise RuntimeError('cannot_preserve_auto_remove_runtime')

def verify_sources(name,baseline):
    original={x['path']:x['sha256'] for x in baseline['sources'] if x['container']==name}
    code="import fs from 'node:fs';import crypto from 'node:crypto';const paths="+json.dumps(list(original))+";console.log(JSON.stringify(Object.fromEntries(paths.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));"
    current=json.loads(subprocess.check_output(['docker','exec','-i',name,'node','--input-type=module'],input=code.encode()))
    if current!=original:raise RuntimeError('live_source_changed_reinspect_and_rebuild')

def create_payload(state,image):
    # These Config fields are accepted by Docker create; never reuse dynamic IPAM.
    keys=['Hostname','Domainname','User','AttachStdin','AttachStdout','AttachStderr','ExposedPorts','Tty','OpenStdin','StdinOnce','Env','Cmd','Healthcheck','ArgsEscaped','Volumes','WorkingDir','Entrypoint','NetworkDisabled','Labels','StopSignal','StopTimeout','Shell']
    payload={k:copy.deepcopy(state['Config'][k]) for k in keys if k in state['Config']}
    payload['Image']=image;payload['HostConfig']=copy.deepcopy(state['HostConfig'])
    endpoints={}
    for name,endpoint in state['NetworkSettings']['Networks'].items():
        aliases=[a for a in endpoint.get('Aliases') or [] if a not in (state['Id'],state['Id'][:12])]
        endpoints[name]={'Aliases':aliases}
    payload['NetworkingConfig']={'EndpointsConfig':endpoints}
    return payload

def ensure_healthy(docker,name,timeout=90):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        state=docker.inspect(name)
        if state['State'].get('Health',{}).get('Status')=='healthy':return
        if state['State']['Status'] not in ('created','running','restarting'):break
        time.sleep(1)
    raise RuntimeError('new_runtime_not_healthy')

def apply(docker,name,expected,image,receipt_path,environment=None):
    state=docker.inspect(name);guard(state,expected)
    # Verify that the exact reviewed candidate exists before stopping anything.
    if docker.call('GET','/images/'+image+'/json')['Id']!=image:raise RuntimeError('candidate_image_mismatch')
    payload=create_payload(state,image);backup=name+'-audio-rollback-'+state['Id'][:12]
    # Only public audio feature flags may change. Secrets and every unrelated
    # runtime setting stay byte-for-byte identical to the captured live config.
    if environment:
        if set(environment)-{'AUDIO_CLOUDFLARE_ENABLED','AUDIO_CLOUDFLARE_ASSETS'}:raise RuntimeError('environment_change_out_of_scope')
        payload['Env']=[v for v in state['Config']['Env'] if v.split('=',1)[0] not in environment]
        payload['Env'] += [k+'='+v for k,v in environment.items()]

    receipt={'name':name,'oldId':state['Id'],'oldImage':state['Image'],'backupName':backup,'candidateImage':image}
    # Do not overwrite a previous release/rollback receipt.
    with open(receipt_path,'x',encoding='utf-8') as f:json.dump(receipt,f,indent=2)
    docker.call('POST','/containers/'+name+'/stop?t=30')
    try:
        docker.call('POST','/containers/'+name+'/rename?name='+backup)
        created=docker.call('POST','/containers/create?name='+name,payload)
        receipt['newId']=created['Id']
        with open(receipt_path,'w',encoding='utf-8') as f:json.dump(receipt,f,indent=2)
        docker.call('POST','/containers/'+name+'/start');ensure_healthy(docker,name)
        actual=docker.inspect(name)
        if actual['Image']!=image:raise RuntimeError('started_wrong_image')
        # Config image/hostname may differ, all API env/ports/mounts/networks must stay.
        for key in ('Env','Cmd','Entrypoint','WorkingDir','User','Healthcheck'):
            expected_value=payload['Env'] if key=='Env' else state['Config'].get(key)
            if actual['Config'].get(key)!=expected_value:raise RuntimeError('config_drift:'+key)
        for key in ('PortBindings','Binds','Mounts','RestartPolicy'):
            if actual['HostConfig'].get(key)!=state['HostConfig'].get(key):raise RuntimeError('host_config_drift:'+key)
        if set(actual['NetworkSettings']['Networks'])!=set(state['NetworkSettings']['Networks']):raise RuntimeError('network_drift')
        for network,endpoint in payload['NetworkingConfig']['EndpointsConfig'].items():
            if not set(endpoint['Aliases']).issubset(actual['NetworkSettings']['Networks'][network].get('Aliases') or []):raise RuntimeError('network_alias_drift')
        return receipt
    except Exception:
        # Keep failed runtime and the old image; do not delete objects or touch DB.
        rollback(docker,receipt)
        raise

def rollback(docker,receipt):
    name,old=receipt['name'],receipt['backupName']
    original=docker.inspect(receipt['oldId'])
    if original['Id']!=receipt['oldId'] or original['Image']!=receipt['oldImage']:raise RuntimeError('rollback_source_changed')
    # Failure may occur before rename/create. Identify by ID, never stop a foreign runtime.
    if original['Name']=='/'+name:
        docker.call('POST','/containers/'+receipt['oldId']+'/start');ensure_healthy(docker,name);return
    try:current=docker.inspect(name)
    except RuntimeError:current=None
    if current:
        if current['Id']!=receipt.get('newId'):raise RuntimeError('rollback_runtime_changed')
        docker.call('POST','/containers/'+current['Id']+'/stop?t=30')
        docker.call('POST','/containers/'+current['Id']+'/rename?name='+name+'-audio-failed-'+current['Id'][:12])
    docker.call('POST','/containers/'+old+'/rename?name='+name)
    docker.call('POST','/containers/'+name+'/start');ensure_healthy(docker,name)

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['plan','apply','rollback']);p.add_argument('--baseline');p.add_argument('--candidates');p.add_argument('--name');p.add_argument('--receipt',required=True);a=p.parse_args();docker=Docker()
    if a.action=='rollback':
        with open(a.receipt,encoding='utf-8') as f:receipt=json.load(f)
        rollback(docker,receipt);print(json.dumps({'outcome':'rolled_back','name':receipt['name']}));return
    with open(a.baseline,encoding='utf-8') as f:b=json.load(f)
    with open(a.candidates,encoding='utf-8') as f:c=json.load(f)
    expected=next(x for x in b['runtimes'] if x['name']==a.name)
    candidate=next(x for x in c['runtimes'] if x['name']==a.name)
    if candidate['baseImage']!=expected['image']:raise RuntimeError('candidate_base_mismatch')
    state=docker.inspect(a.name);guard(state,expected)
    verify_sources(a.name,b)
    if a.action=='plan':
        print(json.dumps({'outcome':'ready_no_changes','name':a.name,'oldImage':state['Image'],'candidateImage':candidate['candidateImage'],'networks':list(state['NetworkSettings']['Networks'])}));return
    receipt=apply(docker,a.name,expected,candidate['candidateImage'],a.receipt);print(json.dumps({'outcome':'healthy_canary_pending',**receipt}))

if __name__=='__main__':main()
