import os,re,sys,shutil
root=os.environ.get('LZ_MONOREPO') or sys.exit('set LZ_MONOREPO to a checkout of LayerZero-Labs/monorepo-external at LZ_COMMIT')
M={'common-utils-macros-stellar-contracts':'contracts/common/utils/stellar/common-utils-macros',
'common-utils-stellar-contracts':'contracts/common/utils/stellar/common-utils',
'oapp-stellar-contracts':'apps/project-types/oapp-app/contracts/stellar/contracts',
'oapp-macros-stellar-contracts':'apps/project-types/oapp-app/contracts/stellar/macros',
'protocol-stellar-v2':'apps/project-types/protocol-app/contracts/stellar/contracts',
'oft-core-stellar-contracts':'apps/oft-app/contracts/stellar/oft-core',
'sac-manager-stellar-contracts':'apps/oft-app/contracts/stellar/sac-manager'}
target=os.path.abspath(sys.argv[1]); deps=os.path.join(target,'dependencies')
PAT=re.compile(r'path\s*=\s*"([^"]*?)dependencies/([^/"]+)((?:/[^"]*)?)"')
def needed(pkgdir):
    out=set()
    for dp,dn,fn in os.walk(pkgdir):
        dn[:]=[d for d in dn if d not in('target','dependencies','node_modules')]
        if 'Cargo.toml' in fn:
            for _,n,_ in PAT.findall(open(os.path.join(dp,'Cargo.toml')).read()): out.add(n)
    return out
todo=list(needed(target)); done=set()
while todo:
    n=todo.pop()
    if n in done: continue
    done.add(n); src=os.path.join(root,M[n]); dst=os.path.join(deps,n)
    if os.path.lexists(dst): shutil.rmtree(dst) if not os.path.islink(dst) else os.unlink(dst)
    shutil.copytree(src,dst,ignore=shutil.ignore_patterns('target','dependencies','node_modules','Cargo.lock','rust-toolchain.toml','.git'))
    todo+=list(needed(src))
def rewrite(cargo, is_target=False):
    t=open(cargo).read(); d=os.path.dirname(cargo)
    def r(mo):
        n,rest=mo.group(2),mo.group(3)
        return 'path = "%s"'%os.path.relpath(os.path.join(deps,n)+rest,d)
    t=PAT.sub(r,t)
    if not is_target:
        t=re.sub(r'(?ms)^\[(patch|profile)[^\]]*\].*?(?=^\[|\Z)','',t)
    open(cargo,'w').write(t)
for dp,dn,fn in os.walk(deps):
    if 'Cargo.toml' in fn: rewrite(os.path.join(dp,'Cargo.toml'))
print('vendored',sorted(done))
