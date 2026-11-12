"""Preserve the job identifier emitted by the K56 online Writing receiver."""

import argparse
from hashlib import sha256
import json
from pathlib import Path


BEFORE = '9ce0236accb48469f87e1fa45c3265e15017d03556df450b6c0ce90bca2bb52a'


def stage(source, destination):
    original = source.read_bytes()
    if sha256(original).hexdigest() != BEFORE:
        raise ValueError('Unexpected K56 Exam Journal adapter fingerprint')
    text = original.decode('utf-8')
    anchor = '    if(k56Offline)data.checkpointState=k56Offline;'
    if text.count(anchor) != 1:
        raise ValueError('Unexpected K56 Exam Journal integration point')
    update = """    if(k56Offline)data.checkpointState=k56Offline;
    if (event === 'job_queued' && k56Offline?.operationId && k56Offline.receiptId && details.section === 'writing') {
      const task = testSlug === 'term-test-1-k56' ? 2 : testSlug === 'term-test-2-k56' ? 1 : null;
      if (task !== null && details.task === task && UUID.test(details.jobId || '')) {
        data.jobId = details.jobId.toLowerCase();
        data.task = task;
      }
    }"""
    output = text.replace(anchor, update, 1).encode('utf-8')
    with destination.open('xb') as file:
        file.write(output)
    print(json.dumps({'before':BEFORE, 'after':sha256(output).hexdigest()}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    stage(args.source, args.destination)
