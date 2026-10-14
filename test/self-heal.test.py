import importlib.util, pathlib, unittest
spec=importlib.util.spec_from_file_location('heal',pathlib.Path(__file__).resolve().parents[1]/'scripts/self-heal.py')
heal=importlib.util.module_from_spec(spec);spec.loader.exec_module(heal)
class Recovery(unittest.TestCase):
    def snapshot(self,**kw): return {'proton-bridge':'active','proton-mail-connector':'active','http':True,'bridge':True,**kw}
    def test_healthy_and_transient(self):
        bad=self.snapshot(http=False)
        self.assertEqual(heal.plan(bad,self.snapshot(),[],10000),[])
        self.assertEqual(heal.plan(self.snapshot(),self.snapshot(),[],10000),[])
    def test_http_hang_only_restarts_connector(self):
        bad=self.snapshot(http=False)
        self.assertEqual(heal.plan(bad,bad,[],10000),['proton-mail-connector'])
    def test_bridge_hang_restarts_in_dependency_order(self):
        bad=self.snapshot(bridge=False)
        self.assertEqual(heal.plan(bad,bad,[],10000),list(heal.UNITS))
    def test_intentional_stop_and_unknown_state(self):
        for state in ['inactive','deactivating','unknown']:
            bad=self.snapshot(bridge=False,**{'proton-bridge':state})
            self.assertEqual(heal.plan(bad,bad,[],10000),[])
    def test_rate_limit_and_clock_rollback(self):
        bad=self.snapshot(http=False)
        for attempts in [[9900,9950],[11000],['bad']]: self.assertEqual(heal.plan(bad,bad,attempts,10000),[])
        self.assertEqual(heal.plan(bad,bad,[100,200],10000),['proton-mail-connector'])
if __name__=='__main__': unittest.main()
