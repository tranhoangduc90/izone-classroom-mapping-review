"""Enable new Term 1 offline sessions within the approved hold scope."""

import argparse
from hashlib import sha256
import json
from pathlib import Path


BASE = '932469679121898271b6e145b589cf540586bd6db237ad5ef95e13e67edaf20a'


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError('Unexpected Term 1 offline integration point')
    return source.replace(before, after, 1)


def build(source, destination):
    data = source.read_bytes()
    if sha256(data).hexdigest() != BASE:
        raise ValueError('Unexpected Term 1 offline source')
    text = replace_once(data.decode('utf-8'),
        "allowNew=()=>profile.tablePrefix==='term1'?process.env[profile.flag]==='true':process.env[profile.flag]!=='false'",
        'allowNew')
    text = replace_once(text,
        """    if(!allowNew())throw fail('OFFLINE_NEW_DISABLED','Lượt mới đang dùng chế độ tương thích.',503);
    if(current.listening_started_at||current.reading_started_at||current.writing_started_at)throw fail('OFFLINE_LEGACY','Lượt đang làm tiếp tục cơ chế cũ; nháp vẫn được giữ.');
    const enroll=profile.tablePrefix==='term1'&&holdPolicy.admits(current.class_name_snapshot||body.classCode);""",
        """    const enroll=profile.tablePrefix==='term1'&&holdPolicy.admits(current.class_name_snapshot||body.classCode);
    const flag=process.env[profile.flag];
    const defaultNew=profile.tablePrefix==='term1' ? flag==='true'||(flag===undefined&&enroll) : flag!=='false';
    if(!(allowNew ? allowNew() : defaultNew))throw fail('OFFLINE_NEW_DISABLED','Lượt mới đang dùng chế độ tương thích.',503);
    if(current.listening_started_at||current.reading_started_at||current.writing_started_at)throw fail('OFFLINE_LEGACY','Lượt đang làm tiếp tục cơ chế cũ; nháp vẫn được giữ.');""")
    output = text.encode('utf-8')
    with destination.open('xb') as file:
        file.write(output)
    print(json.dumps({'before':BASE,'after':sha256(output).hexdigest()}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    build(args.source, args.destination)
