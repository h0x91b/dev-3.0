import subprocess,json,time
cmd=['agent-browser','--session','artifact1797']
def run(*a):
 r=subprocess.run(cmd+list(a),capture_output=True,text=True,timeout=8)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout
for batch in range(2):
 run('eval','__resizeProbe.gaps=[];__resizeProbe.long=[];__resizeProbe.start=performance.now();"reset"')
 for i in range(20):
  b=json.loads(json.loads(run('eval','JSON.stringify(document.querySelector("[role=separator]").getBoundingClientRect().toJSON())')))
  x=round(b['x']+3);y=round(b['y']+100);target=490 if i%2==0 else 1078
  run('mouse','move',str(x),str(y));run('mouse','down','left')
  run('mouse','move',str(target),str(y));run('mouse','up','left')
  time.sleep(.15)
 result=run('eval','JSON.stringify({duration:performance.now()-__resizeProbe.start,resizes:20,loads:__resizeProbe.loads,srcMutations:__resizeProbe.mutations,sameFrame:__originalFrame===document.querySelector("iframe"),maxGap:Math.max(...__resizeProbe.gaps),p95:__resizeProbe.gaps.sort((a,b)=>a-b)[Math.floor(__resizeProbe.gaps.length*.95)],frames:__resizeProbe.gaps.length,long:__resizeProbe.long,width:document.querySelector("[role=separator]").getAttribute("aria-valuenow")})')
 print(result,flush=True)
