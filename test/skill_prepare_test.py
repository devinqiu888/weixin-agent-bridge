"""Offline checks for the skill's configuration/secret preparation helper."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('prepare', ROOT / 'skills/deploy-weixin-bridge/scripts/prepare_deployment.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / 'repo'
        self.repo.mkdir()
        (self.repo / 'src').mkdir()
        for name in ['index.ts', 'account.ts', 'oauth-state.ts']:
            (self.repo / 'src' / name).touch()
        for name in ['package.json', 'wrangler.jsonc']:
            (self.repo / name).write_bytes((ROOT / name).read_bytes())
        self.secret = Path(self.temp.name) / 'private' / 'token'
        self.args = (self.repo, 'personal-bridge', 'https://personal-bridge.example.workers.dev', self.secret)

    def test_dry_run_has_no_side_effects(self):
        before = (self.repo / 'wrangler.jsonc').read_bytes()
        result = MODULE.prepare(*self.args, dry_run=True)
        self.assertFalse(self.secret.exists())
        self.assertEqual(before, (self.repo / 'wrangler.jsonc').read_bytes())
        self.assertFalse(result['deployed'])

    def test_prepare_and_rerun_preserve_secret_and_bindings(self):
        before = json.loads((self.repo / 'wrangler.jsonc').read_text())
        result = MODULE.prepare(*self.args)
        token = self.secret.read_text()
        self.assertEqual(len(token.strip()), 64)
        self.assertNotIn(token.strip(), json.dumps(result))
        if os.name == 'posix':
            self.assertEqual(self.secret.stat().st_mode & 0o777, 0o600)
        config = json.loads((self.repo / 'wrangler.jsonc').read_text())
        self.assertEqual(config['migrations'], before['migrations'])
        self.assertEqual(config['durable_objects']['bindings'], before['durable_objects']['bindings'])
        self.assertEqual(config['vars']['CALLBACK_HOSTS'], '')
        config['vars']['CALLBACK_HOSTS'] = 'connectors.api.openai.com'
        (self.repo / 'wrangler.jsonc').write_text(json.dumps(config))
        MODULE.prepare(*self.args)
        self.assertEqual(token, self.secret.read_text())
        self.assertEqual(json.loads((self.repo / 'wrangler.jsonc').read_text())['vars']['CALLBACK_HOSTS'], 'connectors.api.openai.com')

    def test_fresh_deployment_rejects_existing_secret(self):
        self.secret.parent.mkdir()
        self.secret.write_text('a' * 64 + '\n')
        self.secret.chmod(0o600)
        before = (self.repo / 'wrangler.jsonc').read_bytes()
        with self.assertRaises(ValueError):
            MODULE.prepare(*self.args)
        self.assertEqual(before, (self.repo / 'wrangler.jsonc').read_bytes())
        self.assertEqual(self.secret.read_text().strip(), 'a' * 64)

    def test_rerun_rejects_substituted_secret(self):
        MODULE.prepare(*self.args)
        self.secret.write_text('b' * 64 + '\n')
        with self.assertRaises(ValueError):
            MODULE.prepare(*self.args)

    def test_reject_bad_origin_and_secret_inside_repo(self):
        for origin in ['http://example.com', 'https://example.com/', 'https://u:p@example.com', 'https://example.com/mcp']:
            with self.assertRaises(ValueError):
                MODULE.prepare(self.repo, 'personal-bridge', origin, self.secret)
        with self.assertRaises(ValueError):
            MODULE.prepare(self.repo, 'personal-bridge', self.args[2], self.repo / 'token')
        self.assertFalse(self.secret.exists())

    def test_conflicting_target_and_missing_existing_secret_fail_closed(self):
        MODULE.prepare(*self.args)
        before = (self.repo / 'wrangler.jsonc').read_bytes()
        with self.assertRaises(ValueError):
            MODULE.prepare(self.repo, 'other-bridge', 'https://other.example.workers.dev', self.secret)
        self.assertEqual(before, (self.repo / 'wrangler.jsonc').read_bytes())
        self.secret.unlink()
        with self.assertRaises(ValueError):
            MODULE.prepare(*self.args)
        self.assertFalse(self.secret.exists())


if __name__ == '__main__':
    unittest.main()
