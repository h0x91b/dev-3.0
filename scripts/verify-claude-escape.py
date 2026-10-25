"""Opt-in live fixture. Requires pexpect and an explicitly chosen Claude binary.
All Claude settings, hooks, credentials and API responses belong to the fixture.
Run: python3 scripts/verify-claude-escape.py /path/to/claude stream
Modes: stream, before, tool, approval, normal. Never calls the real dev3 CLI.
"""
import os, sys, json, tempfile, threading, time, pathlib, http.server, pexpect, subprocess
binary = pathlib.Path(sys.argv[1]).resolve(strict=True)
mode = sys.argv[2] if len(sys.argv) > 2 else 'stream'
assert mode in ['stream', 'before', 'tool', 'approval', 'normal']
print(subprocess.check_output([str(binary), '--version'], text=True).strip(), flush=True)
root = pathlib.Path(tempfile.mkdtemp(prefix='dev3-escape-')).resolve()
(root/'home').mkdir(); (root/'config').mkdir(); (root/'work').mkdir()
(root/'config'/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','customApiKeyResponses':{'approved':['ant-test-placeholder'],'rejected':[]},'projects':{str(root/'work'):{'hasTrustDialogAccepted':True}}}))
hook = root/'hook.py'
hook.write_text('import sys,json,time,pathlib\np=json.load(sys.stdin)\np["probe_sessions"]=[json.loads(f.read_text()) for f in pathlib.Path('+repr(str(root/'config'/'sessions'))+').glob("*.json")]\nwith open('+repr(str(root/'hooks.jsonl'))+',"a") as f: f.write(json.dumps({"time":time.time(),"payload":p})+"\\n")\n')
events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','StopFailure','Notification','PermissionRequest','SessionEnd']
(root/'config'/'settings.json').write_text(json.dumps({'permissions':{'defaultMode':'default','ask':['Bash'] if mode=='approval' else []},'hooks':{e:[{'hooks':[{'type':'command','command':'python3 '+str(hook)}]}] for e in events},'statusLine':{'type':'command','command':'python3 '+str(hook)}}))
started=threading.Event()

class API(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  raw=self.rfile.read(int(self.headers.get('content-length',0)))
  with open(root/'requests.jsonl','a') as f:f.write(json.dumps({'path':self.path,'body':json.loads(raw)})+'\n')
  self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
  def emit(e,d):self.wfile.write(('event: '+e+'\ndata: '+json.dumps(d)+'\n\n').encode());self.wfile.flush()
  try:
   if mode=='before':
    started.set(); time.sleep(20)
   emit('message_start',{'type':'message_start','message':{'id':'msg_probe','type':'message','role':'assistant','model':'claude-sonnet-4-6','content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':1}}})
   if mode in ['tool','approval']:
    emit('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'tool_use','id':'tool_probe','name':'Bash','input':{}}})
    emit('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps({'command':'sleep 20','description':'Wait in isolated cancellation fixture'})}})
    emit('content_block_stop',{'type':'content_block_stop','index':0})
    emit('message_delta',{'type':'message_delta','delta':{'stop_reason':'tool_use','stop_sequence':None},'usage':{'output_tokens':10}})
    emit('message_stop',{'type':'message_stop'}); started.set(); return
   emit('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}})
   emit('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'Fixture response is streaming.'}})
   if mode=='normal':
    emit('content_block_stop',{'type':'content_block_stop','index':0})
    emit('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':10}})
    emit('message_stop',{'type':'message_stop'}); started.set(); return
   started.set()
   for _ in range(60):
    time.sleep(.5); emit('ping',{'type':'ping'})
  except (BrokenPipeError,ConnectionResetError):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),API)
threading.Thread(target=server.serve_forever,daemon=True).start()
env={'PATH':os.environ['PATH'],'HOME':str(root/'home'),'CLAUDE_CONFIG_DIR':str(root/'config'),'TERM':'xterm-256color','ANTHROPIC_API_KEY':'sk-ant-test-placeholder','ANTHROPIC_BASE_URL':'http://127.0.0.1:'+str(server.server_port),'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_AUTOUPDATER':'1'}
print('PROBE_DIR='+str(root),flush=True)
observer=subprocess.Popen(['bun', str(pathlib.Path(__file__).with_name('claude-escape-observer.ts')),str(root)],stdout=subprocess.DEVNULL,env=env)
child=pexpect.spawn(str(binary),[*(['--allowedTools','Bash(sleep *)'] if mode!='approval' else []),'--model','claude-sonnet-4-6','--settings',str(root/'config'/'settings.json'),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],cwd=str(root/'work'),env=env,encoding='utf-8',timeout=1,dimensions=(40,120))
log=open(root/'terminal.log','w'); child.logfile_read=log

def descendant_commands():
 rows=subprocess.check_output(['ps','-axo','pid=,ppid=,comm='],text=True).splitlines()
 parsed=[row.strip().split(None,2) for row in rows]
 owned={child.pid}
 for _ in range(20):
  added={int(pid) for pid,ppid,comm in parsed if int(ppid) in owned}
  if added.issubset(owned): break
  owned.update(added)
 return [comm for pid,ppid,comm in parsed if int(pid) in owned and int(pid)!=child.pid]
def hook_events():
 try:return [json.loads(line)['payload'].get('hook_event_name') for line in (root/'hooks.jsonl').read_text().splitlines()]
 except (FileNotFoundError,json.JSONDecodeError):return []
try:
 for i in range(25):
  try:
   child.expect(['trust this folder','Yes, I trust','API key','Select.*theme','❯'],timeout=1)
   print('matched',child.after,flush=True)
   if child.after=='❯':break
   child.send('\r')
  except pexpect.TIMEOUT:pass
 time.sleep(1)
 child.send('Please stream a long response for the cancellation fixture.')
 time.sleep(.3)
 child.send('\r')
 deadline=time.monotonic()+20
 while time.monotonic()<deadline:
  try:child.read_nonblocking(20000,timeout=.5)
  except pexpect.TIMEOUT:pass
  if started.is_set():break
 print('STREAM_STARTED='+str(started.is_set()),flush=True)
 if started.is_set():
  deadline=time.monotonic()+10
  while mode in ['tool','approval','normal'] and time.monotonic()<deadline:
   ready=('sleep' in descendant_commands()) if mode=='tool' else (('PermissionRequest' if mode=='approval' else 'Stop') in hook_events())
   if ready:break
   try:child.read_nonblocking(20000,timeout=.2)
   except pexpect.TIMEOUT:pass
  if mode=='tool':assert 'sleep' in descendant_commands(), 'Bash never started the fixture subprocess'
  if mode=='approval':assert 'PermissionRequest' in hook_events(), 'Fixture never requested approval'
  if mode=='normal':assert 'Stop' in hook_events(), 'Fixture did not finish normally'
  time.sleep(.5)
  for f in (root/'config'/'projects').glob('*/*.jsonl'): (root/'before.jsonl').write_text(f.read_text())
  for f in (root/'config'/'sessions').glob('*.json'): (root/'session-before.json').write_text(f.read_text())
  child.send('\x1b'); print('ESCAPE_SENT',flush=True)
  deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   try:child.read_nonblocking(20000,timeout=.5)
   except pexpect.TIMEOUT:pass
 if mode=='tool':assert 'sleep' not in descendant_commands(), 'Cancelled foreground subprocess still running'
 for f in (root/'config'/'sessions').glob('*.json'): (root/'session-after.json').write_text(f.read_text())
 for f in (root/'config'/'projects').glob('*/*.jsonl'): (root/'after.jsonl').write_text(f.read_text())
finally:
 child.terminate(force=True);server.shutdown();log.close()
 observer.terminate(); observer.wait(timeout=5)
print('HOOKS='+str(root/'hooks.jsonl'),flush=True)

assert started.is_set(), 'Fixture never reached the local API'
observed=json.loads((root/'observed-status.json').read_text())['status']
expected='review-by-user' if mode=='normal' else 'user-questions'
print('OBSERVED='+observed+' EXPECTED='+expected,flush=True)
assert observed == expected

if mode!='normal':assert 'Stop' not in hook_events(), 'Cancellation unexpectedly emitted Stop'
