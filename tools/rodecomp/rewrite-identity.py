import subprocess
repo='/data/repo'
subprocess.run(['git','-C',repo,'filter-repo','--force',
 '--blob-callback', "import re; blob.data = re.sub(rb'(?i)[a-z0-9.!#$%&*+/=?^_`{|}~-]*spl3en[a-z0-9.!#$%&*+/=?^_`{|}~-]*@[a-z0-9.-]+', b'ragnarok-clanker', blob.data); blob.data = re.sub(rb'(?i)spl3en', b'ragnarok-clanker', blob.data)",
 '--message-callback', "import re; message = re.sub(rb'(?i)[a-z0-9.!#$%&*+/=?^_`{|}~-]*spl3en[a-z0-9.!#$%&*+/=?^_`{|}~-]*@[a-z0-9.-]+', b'ragnarok-clanker', message); return re.sub(rb'(?i)spl3en', b'ragnarok-clanker', message)",
 '--name-callback', "import re; return re.sub(rb'(?i)spl3en', b'ragnarok-clanker', name)",
 '--email-callback', "return b'ragnarok-clanker' if b'spl3en' in email.lower() else email",
 '--filename-callback', "import re; return re.sub(rb'(?i)spl3en', b'ragnarok-clanker', filename)",
 '--refname-callback', "import re; return re.sub(rb'(?i)spl3en', b'ragnarok-clanker', refname)"
],check=True)
