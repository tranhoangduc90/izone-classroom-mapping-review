"""Đọc topology Docker để khóa đúng API/database trước từng thao tác fixture.
Không trả credential; đích sai/trùng/đã thay đổi phải chặn trước query hoặc ghi.
"""
from urllib.parse import urlsplit,unquote
import release_remote as r

def resolve(item, destination, inspect=None, network=None):
    inspect=inspect or r.inspect
    network=network or (lambda identifier:r.api('GET','/networks/'+identifier))
    schema,db_name,database=destination(item)
    app=inspect(item['name']);db=inspect(db_name)
    if app['Name']!='/'+item['name'] or db['Name']!='/'+db_name:
        raise RuntimeError('database_binding_name_changed')
    if not app['State']['Running'] or not db['State']['Running']:
        raise RuntimeError('database_binding_not_running')
    urls=[x.split('=',1)[1] for x in app['Config'].get('Env',[]) if x.startswith('DATABASE_URL=')]
    if len(urls)!=1:raise RuntimeError('database_binding_url_missing')
    try:
        parsed=urlsplit(urls[0]);host=parsed.hostname
        if parsed.scheme not in ('postgres','postgresql') or not host or unquote(parsed.path.lstrip('/'))!=database:
            raise ValueError()
        port=parsed.port or 5432
    except Exception:raise RuntimeError('database_binding_url_invalid') from None
    matches={}
    endpoints=app['NetworkSettings']['Networks']
    for net_name,endpoint in endpoints.items():
        net_id=endpoint.get('NetworkID')
        if not net_id:raise RuntimeError('database_binding_network_unknown')
        view=network(net_id)
        if view['Id']!=net_id:raise RuntimeError('database_binding_network_changed')
        for identifier in view.get('Containers',{}):
            container=inspect(identifier)
            peer=container['NetworkSettings']['Networks'].get(net_name)
            if not peer or peer.get('NetworkID')!=net_id:
                raise RuntimeError('database_binding_peer_network_changed')
            aliases={container['Name'].lstrip('/'),identifier,identifier[:12],*(peer.get('Aliases') or [])}
            address=str(peer.get('IPAddress') or '')
            if host in aliases or host==address:
                if not container['State']['Running']:raise RuntimeError('database_binding_peer_not_running')
                matches.setdefault(identifier,[]).append(net_id)
    if set(matches)!={db['Id']}:
        raise RuntimeError('database_binding_wrong_or_ambiguous')
    db_networks=sorted(matches[db['Id']])
    if len(db_networks)!=1:raise RuntimeError('database_binding_multiple_networks')
    return {'name':item['name'],'api_id':app['Id'],'db_id':db['Id'],'db_container':db_name,
            'database':database,'schema':schema,'host':host,'port':port,'network_id':db_networks[0]}

def require(item,destination):
    expected=item.get('_database_binding')
    if not isinstance(expected,dict):raise RuntimeError('database_binding_not_frozen')
    actual=resolve(item,destination)
    if actual!=expected:raise RuntimeError('database_binding_stale')
    return actual

