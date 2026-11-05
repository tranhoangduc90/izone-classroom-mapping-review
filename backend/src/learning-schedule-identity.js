// A published worksheet owns an ERP session ID, not that row's position or clock.
// Full fingerprints remain in the Portal contract; this check qualifies refreshing
// their metadata without changing the target, revision, decisions or old operations.
function schedule(value) {
  try {
    const parsed=JSON.parse(value);
    if(!Array.isArray(parsed)||parsed.length!==2||!Array.isArray(parsed[1])||!/^\d+$/.test(String(parsed[0])))return null;
    const ids=new Set(),starts=new Set(),rows=new Map();
    for(const row of parsed[1]){
      if(!Array.isArray(row)||row.length!==4||!/^[1-9]\d*$/.test(row[0])||ids.has(row[0])
        ||typeof row[1]!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row[1])
        ||!Number.isFinite(Date.parse(row[1].replace(' ','T')+'Z'))||typeof row[2]!=='string'||![0,1,2].includes(row[3]))return null;
      if(row[3]!==2&&starts.has(row[1]))return null;
      ids.add(row[0]);if(row[3]!==2)starts.add(row[1]);rows.set(row[0],row);
    }
    return {classId:String(parsed[0]),rows};
  }catch{return null;}
}

export function canRefreshBoundSchedule(binding,current) {
  const id=String(binding?.targetSessionId??binding?.target_session_id??'');
  const before=schedule(binding?.scheduleFingerprint??binding?.schedule_fingerprint);
  const after=schedule(current?.scheduleFingerprint);
  if(!before||!after||before.classId!==after.classId||String(current?.targetSessionId)!==id)return false;
  const old=before.rows.get(id),next=after.rows.get(id);
  return Boolean(old&&next&&[0,1].includes(old[3])&&[0,1].includes(next[3]));
}

export function currentConfirmedDates(dates,schedule) {
  if(!schedule||schedule.ambiguous)return dates;
  const byId=new Map(schedule.sessions.map(row=>[String(row.erpSessionId),row]));
  return dates.map(slot=>{const row=byId.get(slot.erpSessionId);
    return row&&[0,1].includes(row.statusCode)?{...slot,date:row.date}:slot;});
}
