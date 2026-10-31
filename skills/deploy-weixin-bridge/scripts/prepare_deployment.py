#!/usr/bin/env python3
"""Prepare a fresh bridge checkout; no network calls or secret output."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
from urllib.parse import urlsplit


def prepare(repo, worker_name, origin, secret_file, dry_run=False):
    repo = Path(repo).resolve()
    original_secret = Path(secret_file).absolute()
    if original_secret.is_symlink():
        raise ValueError('Secret file must not be a symlink')
    secret_file = original_secret.resolve()
    if secret_file.is_relative_to(repo):
        raise ValueError('Secret file must be outside the source repository')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', worker_name):
        raise ValueError('Worker name must use lowercase letters, digits and hyphens, starting with a letter')
    url = urlsplit(origin)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.port or url.path or url.query or url.fragment
            or url.hostname == 'localhost' or '.' not in url.hostname):
        raise ValueError('Origin must be an explicit HTTPS origin without path, port, or credentials')
    if origin != 'https://' + url.hostname:
        raise ValueError('Use a normalized lowercase HTTPS origin without a trailing slash')
    config_path = repo / 'wrangler.jsonc'
    if config_path.is_symlink():
        raise ValueError('Wrangler config must not be a symlink')
    # Upstream uses JSON-compatible JSONC; do not strip comments with unsafe regexes.
    config = json.loads(config_path.read_text())
    package = json.loads((repo / 'package.json').read_text())
    if package.get('name') != 'weixin-agent-bridge':
        raise ValueError('Not a Weixin Agent Bridge checkout')
    if not all((repo / 'src' / name).is_file() for name in ['index.ts', 'account.ts', 'oauth-state.ts']):
        raise ValueError('Required bridge sources are missing')
    bindings = {(b.get('name'), b.get('class_name')) for b in config.get('durable_objects', {}).get('bindings', [])}
    if not {('ACCOUNTS', 'WeixinAccount'), ('OAUTH', 'OAuthState')} <= bindings:
        raise ValueError('Required Durable Object bindings are missing')
    current_origin = config.get('vars', {}).get('APP_ORIGIN')
    same_target = config.get('name') == worker_name and current_origin == origin
    fresh = config.get('name') == 'weixin-agent-bridge' and current_origin == 'http://localhost:8787'
    if not (fresh or same_target):
        raise ValueError('Checkout already targets another deployment; preserve it and use a fresh copy')
    if same_target and not secret_file.exists():
        raise ValueError('Configured deployment has no matching secret file; do not silently rotate its secret')
    receipt = secret_file.with_name(secret_file.name + '.deployment.json')
    expected_target = {'repo': str(repo), 'worker': worker_name, 'origin': origin}
    if fresh and (secret_file.exists() or receipt.exists()):
        raise ValueError('Fresh deployments require a new secret path; never reuse another deployment token')
    if secret_file.exists():
        info = secret_file.stat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Secret path must be a regular file')
        if os.name == 'posix' and stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError('Existing secret file must be private (mode 0600)')
        if not re.fullmatch(r'[0-9a-f]{64}', secret_file.read_text().strip()):
            raise ValueError('Existing secret does not match this helper format; preserve it and configure manually')
        if receipt.is_symlink() or not receipt.is_file():
            raise ValueError('Existing secret has no verified deployment receipt')
        saved = json.loads(receipt.read_text())
        expected = {**expected_target, 'secret_hash': hashlib.sha256(secret_file.read_bytes()).hexdigest()}
        if saved != expected:
            raise ValueError('Existing secret belongs to a different deployment')
    config['name'] = worker_name
    config['vars']['APP_ORIGIN'] = origin
    if fresh:
        config['vars']['EVENTS_DISCOVERY_ENABLED'] = 'true'
        config['vars']['CALLBACK_HOSTS'] = ''
        config['vars']['OAUTH_REDIRECT_URIS'] = 'https://chatgpt.com/connector_platform_oauth_redirect'
    config['durable_objects']['code_update_strategy'] = {'mode': 'immediate'}
    if not dry_run:
        secret_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not secret_file.exists():
            fd = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as out:
                out.write(secrets.token_hex(32) + '\n')
            receipt_fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(receipt_fd, 'w') as out:
                json.dump({**expected_target, 'secret_hash': hashlib.sha256(secret_file.read_bytes()).hexdigest()}, out)
        fd, temp_name = tempfile.mkstemp(prefix='.wrangler-prepare-', dir=repo)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(config, out, indent=2)
                out.write('\n')
            os.replace(temp_name, config_path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    return {'mode': 'dry-run' if dry_run else 'prepared', 'worker': worker_name,
            'origin': origin, 'mcp_url': origin + '/mcp',
            'secret_file': str(secret_file), 'deployed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--worker-name', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--secret-file', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        result = prepare(args.repo, args.worker_name, args.origin, args.secret_file, args.dry_run)
    except (ValueError, OSError):
        # Errors may include file content from parsers: never dump input or credentials.
        parser.exit(2, 'Preparation refused: check target, origin, config, and private secret-file requirements. No credentials were printed.\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
