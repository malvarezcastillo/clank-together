import argparse
import re
import subprocess

parser = argparse.ArgumentParser(description='Replace a private identity with ragnarok-clanker in Git history.')
parser.add_argument('identity', help='Private identity to replace, case-insensitively')
parser.add_argument('--repo', default='/data/repo', help='Repository whose history will be rewritten')
args = parser.parse_args()
if not args.identity:
    parser.error('identity must not be empty')

identity = re.escape(args.identity.encode())
pattern = b'(?i)' + identity
email_pattern = rb'(?i)[a-z0-9.!#$%&*+/=?^_`{|}~-]*' + identity + rb'[a-z0-9.!#$%&*+/=?^_`{|}~-]*@[a-z0-9.-]+'
replace = f"re.sub({pattern!r}, b'ragnarok-clanker', value)"
replace_email = f"re.sub({email_pattern!r}, b'ragnarok-clanker', value)"

subprocess.run([
    'git', '-C', args.repo, 'filter-repo', '--force',
    '--blob-callback', f'import re; value = blob.data; value = {replace_email}; blob.data = {replace}',
    '--message-callback', f'import re; value = message; value = {replace_email}; return {replace}',
    '--name-callback', f'import re; value = name; return {replace}',
    '--email-callback', f"import re; return b'ragnarok-clanker' if re.search({pattern!r}, email) else email",
    '--filename-callback', f'import re; value = filename; return {replace}',
    '--refname-callback', f'import re; value = refname; return {replace}',
], check=True)
