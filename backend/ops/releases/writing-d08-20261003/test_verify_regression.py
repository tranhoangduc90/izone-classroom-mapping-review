"""Cùng ca kiểm chặn biên nhận chỉ có cờ success trên adapter base/head.
Toàn bộ runtime/public được giả lập; không SSH, không gọi production.
"""
import importlib.util,json,os,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).parent
source=Path(os.environ.get('D08_RECEIPT_ADAPTER_UNDER_TEST',str(HERE/'release_adapter.py')))
spec=importlib.util.spec_from_file_location('receipt_adapter_under_test',source)
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)


class ReceiptRegression(unittest.TestCase):
    def test_fields_only_success_receipt_does_not_verify_business(self):
        snapshot={'fixture':'runtime'}
        receipt={'status':'passed','snapshots':snapshot,'cleanup_verified':True}
        def read(path,*args,**kwargs):
            if path.name=='production-user-outcome.json':return json.dumps(receipt)
            if path.name=='candidate.json':return json.dumps({'targets':[]})
            return Path.read_text(path,*args,**kwargs)
        original=Path.read_text
        def read_guard(path,*args,**kwargs):
            if path.name in ('production-user-outcome.json','candidate.json'):return read(path,*args,**kwargs)
            return original(path,*args,**kwargs)
        with patch.object(a,'snapshots',return_value=snapshot),patch.object(a,'public_readback',return_value={'status':'passed'}),\
             patch.object(a.Path,'exists',return_value=True),patch.object(a.Path,'read_text',read_guard):
            result=a.verify({'evidence_dir':'fixture-only'})
        self.assertEqual(result['status'],'unknown','Các cờ success chung không chứng minh người dùng đã thấy đúng bài')


if __name__=='__main__':unittest.main(verbosity=2)
