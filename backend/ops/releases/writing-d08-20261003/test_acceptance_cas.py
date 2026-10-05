"""CAS không cho hai sender, trạng thái đổi hoặc crash nhận lại theo tuổi."""
import hashlib,json,os,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
import acceptance_cas as subject

class CasTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.path=Path(self.directory.name)/'executor.json'
        subject.save_exclusive(self.path,{'generation':2,'status':'unknown','pid':99123})
        self.digest=subject.sha(self.path.read_bytes());self.next={'generation':3,'status':'api_started','pid':os.getpid()}
    def claim(self,guard=lambda state:None):
        return subject.claim(self.path,self.digest,2,self.next,guard)
    def test_one_claim_changes_generation_and_preserves_previous(self):
        self.claim();self.assertEqual(json.loads(self.path.read_text())['generation'],3)
        self.assertEqual(json.loads(self.path.with_name('executor.json.generation-2.json').read_text())['generation'],2)
        self.assertTrue(self.path.with_name('executor.json.cas-generation-2.json').exists())
    def test_second_sender_cannot_replay(self):
        self.claim()
        with self.assertRaisesRegex(RuntimeError,'state_changed'):self.claim()
    def test_stale_hash_blocks_without_claim(self):
        subject.replace_durable(self.path,{'generation':2,'status':'changed'})
        with self.assertRaisesRegex(RuntimeError,'state_changed'):self.claim()
        self.assertFalse(self.path.with_name('executor.json.cas-generation-2.json').exists())
    def test_sender_alive_guard_blocks(self):
        def guard(state):raise RuntimeError('sender_alive')
        with self.assertRaisesRegex(RuntimeError,'sender_alive'):self.claim(guard)
        self.assertEqual(json.loads(self.path.read_text())['generation'],2)
    def test_drift_after_exclusive_claim_keeps_lock_and_old_state(self):
        count=0
        def guard(state):
            nonlocal count;count+=1
            if count==2:raise RuntimeError('runtime_drift')
        with self.assertRaisesRegex(RuntimeError,'runtime_drift'):self.claim(guard)
        self.assertTrue(self.path.with_name('executor.json.cas-generation-2.json').exists())
        self.assertEqual(json.loads(self.path.read_text())['generation'],2)
        with self.assertRaises(FileExistsError):self.claim()
    def test_bad_next_generation_blocks(self):
        self.next['generation']=5
        with self.assertRaisesRegex(RuntimeError,'next_generation'):self.claim()
    def test_concurrent_claim_has_exactly_one_winner(self):
        outcomes=[];barrier=threading.Barrier(2)
        def sender():
            barrier.wait()
            try:self.claim();outcomes.append('won')
            except (RuntimeError,FileExistsError):outcomes.append('blocked')
        threads=[threading.Thread(target=sender) for _ in range(2)]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertCountEqual(outcomes,['won','blocked'])
    def test_crash_before_pointer_replace_keeps_claim(self):
        with patch.object(subject,'replace_durable',side_effect=OSError('synthetic_crash')):
            with self.assertRaises(OSError):self.claim()
        with self.assertRaises(FileExistsError):self.claim()
        self.assertEqual(json.loads(self.path.read_text())['generation'],2)

if __name__=='__main__':unittest.main()
