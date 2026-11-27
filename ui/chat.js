window.chatExplorer = (() => {
  const sources = [
    {key:"codex", name:"Codex", hint:"还没有找到本机的 Codex 对话。"},
    {key:"antigravity", name:"Antigravity", hint:"还没有找到可读取的 Antigravity 对话原文。"},
    {key:"claude", name:"Claude Code", hint:"还没有找到 Claude Code 的项目对话。"},
    {key:"deepseek", name:"DeepSeek Harness", hint:"还没有找到本机的 DeepSeek Harness 对话。"},
  ];
  const el = (tag, cls, text) => { const n=node(tag,text); if(cls)n.className=cls; return n; };
  const button = (cls, text, fn) => { const b=el("button",cls,text); b.type="button"; b.onclick=fn; return b; };
  function mark(src) {
    const img=el("img","chat-mark "+src.key);
    img.alt="";img.draggable=false;img.src="/brands/"+src.key+".png";
    return img;
  }
  const sourceOf = item => sources.find(s=>s.key===item.source);
  const leaf = path => path.replace(/[\\/]+$/,"").split(/[\\/]/).pop() || path;
  const dateOf = value => {
    const d=new Date(typeof value==="string" && /^\d{13}$/.test(value)?Number(value):value);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false});
  };
  let visible=false, selected="", mode="dialog", entries=[], indexKey=null;
  let targets=null, recipients=[], workspacePaths=false, handoffTicket=0;
  let desktopFolders=[], quietTransfer=false, namedHarness=false;
  const agentName=key=>key==="antigravitydesktop"?"Antigravity 桌面端":key==="antigravity"?"Antigravity CLI":sources.find(s=>s.key===key)?.name;
  const family=key=>key==="antigravitydesktop"?"antigravity":key;
  const defaultTarget=key=>key==="antigravity"?"antigravitydesktop":key;
  const defaultName=item=>Array.from(sourceOf(item).name+" · "+item.title).slice(0,120).join("");
  const absoluteFolder=p=>/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(p||"");
  let serial=0, indexTicket=0, readTicket=0, generation=0, total=0, first=0, timer=0, reading=false, scanning=false, wanted="", synced="";
  let readKind="", drawnMode="";
  let pendingExport=null;
  let snapshot=null, lastSide="chats", chatFilter="", fileFilter="";
  let outlineTicket=0, outlineKey="", outlineRows=[], outlineError="", outlineLoading=false;
  const outlineParents=new Map();
  let pendingAnchor="", currentAnchor="", pinnedTop=null, anchorNodes=[], scrollFrame=0;
  const folded = new Set();
  const positions={dialog:0, markdown:0};
  const expanded=new Set();
  const tab=button("", "对话",()=>sidebar("chats")); tab.id="chatTab"; tab.title="浏览本地 AI 对话";
  tab.prepend(toolIcon("chat")); $("filesTab").after(tab);
  const side=el("section","chat-side"); side.id="chatLibrary"; side.hidden=true;
  const nav=el("div","chat-nav"); nav.setAttribute("aria-label","对话来源");
  const navHead=el("div","chat-nav-head"); const scanState=button("chat-library-home","最近对话",()=>{home();drawTree();});
  const refresh=button("chat-refresh","",()=>scan()); refresh.append(toolIcon("refresh")); refresh.title="立即刷新"; refresh.setAttribute("aria-label",refresh.title);
  const openLink=button("chat-link-open","打开链接",()=>{
    modal("打开 Codex 对话链接",(body,actions)=>{
      const field=el("input","chat-handoff-target");
      field.placeholder="codex://threads/…";field.setAttribute("aria-label","Codex 对话链接");
      const error=el("p","chat-handoff-scope");error.setAttribute("role","status");
      body.append(field,error);
      const open=()=>{
        const id=threadFromLink(field.value);
        const item=id && entries.find(e=>e.source==="codex" && e.threadId?.toLowerCase()===id);
        if(!item){error.textContent=id?"本机资料库里没有这段对话，请先在原来的 Codex 账号和设备上打开它。":"请粘贴 Codex 对话链接，也可以粘贴完整的 Markdown 链接。";return;}
        $("pop").close();openChat(item);
      };
      field.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();open();}});
      modButton(actions,"取消",()=>$("pop").close());modButton(actions,"打开对话",open,true);
      requestAnimationFrame(()=>field.focus());
    },"paper");
  });
  let allowed=[], prompted=false, setupTicket=0, applySetup=null;
  function openSetup(){
    prompted=true;
    modal("对话来源与接续",(body,actions)=>{
      body.append(el("p","chat-setup-note","选择允许 MarkCraft 在本机读取的智能体记录。接续时，你选择的目标智能体会得到一份新会话。可随时在这里撤回授权。"));
      const panel=el("div","chat-setup-panel"), status=el("p","chat-setup-status","正在检测本机目录…");
      status.setAttribute("role","status");body.append(panel,status);
      const close=modButton(actions,"完成",()=>$("pop").close());
      const save=modButton(actions,"保存选择",()=>send("chatConfigure",JSON.stringify({previous:model.config,next:{sources:draft}})),true);
      save.disabled=true;
      let model=null,draft=[],busy=false;
      function send(action,text="",arg=""){
        busy=true;save.disabled=true;panel.inert=true;close.disabled=true;
        status.textContent=action==="chatInstallPlugin"?"正在通过 Harness 安装插件，请稍候…":action==="chatConfigure"?"正在保存授权…":"正在检测…";
        setupTicket=++serial;post(action,{text,arg,rev:setupTicket});
      }
      function dirty(){return draft.some(d=>{const a=model.config.sources.find(s=>s.source===d.source);return d.enabled!==(a?.enabled||false)||d.folder!==(a?.folder||null);});}
      function draw(){
        panel.replaceChildren();save.disabled=busy||(model.config.sources.length>0&&!dirty());
        for(const info of model.sources){
          const src=sources.find(s=>s.key===info.source),d=draft.find(s=>s.source===info.source);
          const row=el("div","chat-access-row"),label=el("label","chat-access-label"),cb=el("input"),words=el("span","chat-access-words");
          cb.type="checkbox";cb.checked=d.enabled;cb.dataset.source=d.source;cb.setAttribute("aria-label","允许 "+src.name);
          const path=d.folder||info.defaultRoot,changed=path!==info.root;
          const state=changed?"待保存目录":info.inaccessible?"目录无访问权限":info.found?"已发现记录目录":info.client?"已发现客户端，等待本地记录":"尚未发现本地记录";
          words.append(el("strong","",src.name),el("small","",state));label.append(cb,mark(src),words);
          const location=el("div","chat-access-path");const display=el("span","",path===info.defaultRoot?info.defaultLabel:path);display.title=path;
          location.append(display,button("chat-link-open","更改目录",()=>send("chatFolder","",d.source)));
          if(d.folder && path!==info.defaultRoot)location.append(button("chat-link-open","默认",()=>{d.folder=null;draw();}));
          row.append(label,location);panel.append(row);
          cb.onchange=()=>{d.enabled=cb.checked;draw();panel.querySelector('[data-source="'+d.source+'"]')?.focus();};
        }
        const details=el("details","chat-setup-tools"),heading=el("summary","","原生接续组件");details.append(heading);
        details.open=model.config.sources.some(x=>x.source==="deepseek"&&x.enabled);
        const harness=el("div","chat-tool-info");harness.append(el("strong","","DeepSeek Harness"));
        const approved=model.config.sources.some(x=>x.source==="deepseek"&&x.enabled);
        const message=model.bridge?"插件已连接，可以接收会话。":model.pluginVersion?"已安装 "+model.pluginVersion+"。打开或重启 Harness 后重新检测。":"接收会话需要随包提供的插件。先启动一次 Harness，再保存此来源并安装。";
        harness.append(el("p","",message));
        const buttons=el("div","chat-tool-buttons");
        for(const [caption,value] of [["安装接续插件",""],["选择 Harness 程序安装…","@pick"]]){
          const b=button("chat-link-open",caption,()=>send("chatInstallPlugin",value));b.disabled=!approved||dirty()||!model.package;buttons.append(b);
        }
        if(!model.package)harness.append(el("p","","请完整解压便携包，插件应和 MarkCraft.exe 位于同一目录。"));
        if(model.package)buttons.append(button("chat-link-open","定位插件包",()=>post("chatPluginPackage")));
        const check=button("chat-link-open","重新检测",()=>send("chatSetup"));check.disabled=dirty();buttons.append(check);
        harness.append(buttons);details.append(harness,el("p","chat-tool-info","Antigravity 接续需要 agy CLI 1.5.x 和 Node.js 22.13 或更高版本。当前检测到的程序：agy "+(model.agy?"✓":"未找到")+" · Node.js "+(model.node?"✓":"未找到")+"。首次接续前请在终端运行 agy acp --login 登录。Codex 和 Claude Code 可直接接收。"));
        const downloads=el("div","chat-tool-buttons");
        for(const [name,url] of [["Codex","https://developers.openai.com/codex/quickstart/"],["Claude Code","https://code.claude.com/docs/en/setup"],["Antigravity","https://antigravity.google/download"],["Node.js","https://nodejs.org/en/download"],["DeepSeek Harness","https://www.deepseek.com/en/harness/"]]){
          const link=el("a","chat-link-open",name);link.href=url;link.onclick=e=>{e.preventDefault();window.openDocLink(url);};downloads.append(link);
        }
        details.append(el("strong","chat-tool-info","官方下载与安装说明"),downloads);panel.append(details);
      }
      applySetup=m=>{
        busy=false;panel.inert=false;close.disabled=false;
        if(m.error){status.textContent=m.error;if(model)draw();return;}
        if(m.kind==="chatFolder"){if(m.folder)draft.find(s=>s.source===m.id).folder=m.folder;draw();status.textContent="";return;}
        if(m.cancelled){draw();status.textContent="";return;}
        model=m;draft=m.sources.map(info=>{const a=m.config.sources.find(s=>s.source===info.source);return {source:info.source,enabled:a?.enabled||false,folder:a?.folder||null};});
        draw();status.textContent=m.kind==="chatConfigure"?"授权已保存。":m.kind==="chatInstallPlugin"?"安装成功。重新打开 Harness 后点击「重新检测」。":"";
      };
      send("chatSetup");
    },"settings","chat-setup");
  }
  function threadFromLink(value){
    const raw=value.trim().replace(/^\[[^\r\n]*\]\(([^\s()]+)\)$/,"$1");
    return /^codex:\/\/threads\/([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})\/?$/i.exec(raw)?.[1].toLowerCase();
  }
  const manage=button("chat-link-open","管理来源",openSetup);navHead.append(scanState,openLink,manage,refresh); side.append(navHead,nav); $("side").append(side);
  const pane=el("section","chat-pane"); pane.id="chatPane"; pane.hidden=true; pane.setAttribute("aria-label","对话阅读区");
  $("desk").after(pane);
  const appTitle=el("strong","chat-app-title","对话资料库");
  document.querySelector(".toolbar").append(appTitle);
  const head=el("div","chat-read-head"), titleBox=el("div","chat-heading"), title=el("h2"), subtitle=el("div","chat-subtitle");
  const picker=button("chat-picker","‹ 对话列表",()=>{
    if(!prefs.side)sidebar(lastSide);
    document.body.classList.remove("chat-picked");
    (prefs.side==="chatOutline"?$("outlineTab"):tab).focus();
  });
  titleBox.append(title,subtitle); const controls=el("div","chat-controls");
  const dialogBtn=button("","对话",()=>changeMode("dialog")), mdBtn=button("","Markdown",()=>changeMode("markdown"));
  const transfer=button("chat-transfer","接续…",()=>chooseTarget(active()));
  transfer.hidden=true;
  controls.setAttribute("role","group"); controls.setAttribute("aria-label","显示方式"); controls.append(dialogBtn,mdBtn);
  head.append(picker,titleBox,controls,transfer);
  const scroll=el("div","chat-scroll docTheme"), inner=el("div","chat-inner"), transcript=el("div","chat-thread");
  const older=button("chat-older","查看更早的消息",()=>load({before:first}));
  const newer=button("chat-older chat-newer","查看后续消息",()=>load({after:lastMessage()+1}));
  newer.hidden=true;
  const alert=el("div","chat-feedback");alert.setAttribute("role","status");
  const raw=el("article","chat-markdown prose");raw.tabIndex=0;
  raw.setAttribute("aria-label","对话 Markdown 正文");
  raw.addEventListener("click",e=>{
    const a=e.target.closest("a[href]");if(!a)return;e.preventDefault();
    const href=a.getAttribute("href");
    if(href.startsWith("#")) {
      const target=a.closest("section")?.querySelector("#"+CSS.escape(href.slice(1)));
      target?.scrollIntoView({block:"center"});
    } else if(/^(https?:\/\/|mailto:)/i.test(href)) window.openDocLink(href);
  });
  const copy=button("chat-copy-all","复制全文",async()=>{
    const text=snapshot?.text;if(!text)return;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const field=el("textarea","chat-clipboard");field.value=text;document.body.append(field);field.select();
      const copied=document.execCommand("copy");field.remove();copy.focus({preventScroll:true});
      if(!copied){notice("复制失败，可从导出菜单保存 Markdown");return;}
    }
    notice("已复制完整 Markdown");
  });
  head.append(copy);copy.hidden=true;
  inner.append(older,alert,transcript,newer,raw);scroll.append(inner);pane.append(head,scroll);
  function active(){return entries.find(e=>e.id===selected);}
  function resetOutline(){
    outlineTicket=++serial;outlineKey="";outlineRows=[];outlineError="";outlineLoading=false;outlineParents.clear();
    folded.clear();chatFilter="";currentAnchor=pendingAnchor="";pinnedTop=null;anchorNodes=[];
    if(prefs.side==="chatOutline")$("outlineFilter").value="";
  }
  function requestOutline(){
    const chat=active();
    if(prefs.side!=="chatOutline" || !chat)return;
    const key=JSON.stringify([chat.id,chat.modified,chat.size]);
    if(key===outlineKey)return;
    outlineKey=key;outlineError="";outlineLoading=true;outlineTicket=++serial;
    post("chatRead",{arg:chat.id,rev:outlineTicket,text:JSON.stringify({format:"outline"})});
  }
  function indexOutline(messages){
    const rows=[], ancestors=[];let round=0;
    outlineParents.clear();
    function add(key,level,heading){
      while(ancestors.length && ancestors.at(-1).level>=level)ancestors.pop();
      if(ancestors.length)outlineParents.set(key,ancestors.at(-1).id);
      const row={id:key,start:key,level,heading};
      rows.push(row);ancestors.push(row);
    }
    messages.forEach((message,i)=>{
      const question=message.role==="user", level=question || !round ? 1 : 2;
      const label=question ? "第 "+(++round)+" 轮" : sourceOf(active()).name+" 回复";
      const lead=question || !message.headings.length ? message.lead.replace(/^#{1,6}\s+/,"") : "";
      add(String(i),level,label+(lead?" · "+lead:""));
      message.headings.forEach(([depth,text],h)=>add(i+":"+h,level+depth+1,text||"无标题"));
    });
    return rows;
  }
  function drawOutline(){
    if(prefs.side!=="chatOutline")return;
    const focused=$("outline").contains(document.activeElement)?document.activeElement.closest(".outline-row")?.querySelector("[data-pos]")?.dataset.pos:null;
    const top=$("outline").scrollTop;
    const empty=!selected?"选择一段 AI 对话后可查看大纲":outlineError || (outlineLoading || !generation?"正在读取对话大纲…":"暂无对话条目");
    renderOutlineList(outlineRows,folded,b=>jump(b.start),empty);
    $("outline").scrollTop=top;
    if(focused)$("outline").querySelector('[data-pos="'+focused+'"]')?.focus({preventScroll:true});
    markAnchor(currentAnchor);
  }
  function markAnchor(key){
    currentAnchor=key;
    if(prefs.side!=="chatOutline")return;
    const dest=$("outline"), prev=dest.querySelector('[aria-current="location"]');
    let btn=key?dest.querySelector('[data-pos="'+key+'"]'):null;
    let parent=key;
    while(!btn && outlineParents.has(parent)){
      parent=outlineParents.get(parent);btn=dest.querySelector('[data-pos="'+parent+'"]');
    }
    if(btn===prev)return;
    prev?.removeAttribute("aria-current");btn?.setAttribute("aria-current","location");
    if(btn && setting("follow") && !dest.contains(document.activeElement) && document.activeElement!==$("outlineFilter")){
      const item=btn.getBoundingClientRect(),panel=dest.getBoundingClientRect();
      if(item.bottom<panel.top || item.top>panel.bottom)dest.scrollTop+=item.top-panel.top;
    }
  }
  const headingSelector="h1,h2,h3,h4,h5,h6";
  function tagAnchors(block,body,index,skipRole){
    block.dataset.chatAnchor=String(index);
    const headings=Array.from(body.querySelectorAll(headingSelector));
    if(skipRole)headings.shift();
    headings.forEach((heading,h)=>heading.dataset.chatAnchor=index+":"+h);
  }
  function anchorAtScroll(){
    if(!anchorNodes.length)return "";
    if(pinnedTop!==null && Math.abs(scroll.scrollTop-pinnedTop)<2)return currentAnchor;
    pinnedTop=null;
    const top=scroll.getBoundingClientRect().top+14;
    let lo=0,hi=anchorNodes.length;
    while(lo<hi){
      const mid=(lo+hi)>>>1;
      if(anchorNodes[mid].getBoundingClientRect().top<=top)lo=mid+1;else hi=mid;
    }
    return anchorNodes[Math.max(0,lo-1)].dataset.chatAnchor;
  }
  scroll.addEventListener("scroll",()=>{
    if(scrollFrame || prefs.side!=="chatOutline" || pendingAnchor)return;
    scrollFrame=requestAnimationFrame(()=>{
      scrollFrame=0;
      if(visible && !pendingAnchor && scroll.clientHeight)markAnchor(anchorAtScroll());
    });
  },{passive:true});
  function locate(key){
    const container=mode==="markdown"?raw:transcript;
    const target=container.querySelector('[data-chat-anchor="'+key+'"]');
    if(!target || !scroll.clientHeight)return false;
    scroll.scrollTop+=target.getBoundingClientRect().top-scroll.getBoundingClientRect().top-12;
    pinnedTop=scroll.scrollTop;markAnchor(key);
    return true;
  }
  function jump(key){
    document.body.classList.add("chat-picked");
    if((!reading || readKind!=="jump") && drawnMode===mode && locate(key)){
      pendingAnchor="";
      return;
    }
    pendingAnchor=key;
    if(mode==="dialog")load({around:Number(key.split(":")[0])});
    else if(!reading)load({});
  }
  function lastMessage(){return Number(transcript.lastElementChild?.dataset.index ?? -1);}
  // Keep existing buttons and fold containers alive across refreshes and toggles.
  function reconcile(parent, values, keyOf, update) {
    const cache=new Map(Array.from(parent.children,n=>[n.dataset.key,n]));
    values.forEach((value,i)=>{
      const key=keyOf(value), previous=cache.get(key), row=update(previous,value);
      row.dataset.key=key;cache.delete(key);
      if(parent.children[i]!==row)parent.insertBefore(row,parent.children[i]||null);
    });
    for(const stale of cache.values())stale.remove();
  }
  function group(row,key,name,icon,kind,count,detail,fill){
    if(!row){
      row=el("div","chat-group");
      const btn=button("chat-branch "+kind,"",()=>{
        if(expanded.has(key))expanded.delete(key);else expanded.add(key);
        drawTree();
      });
      const fold=el("div","chat-fold"),clip=el("div","chat-fold-clip"),items=el("div","chat-items");
      btn.append(icon(),el("span","chat-label"),el("span","chat-count"),toolIcon("chevron","chat-chevron"));
      fold.append(clip);clip.append(items);row.append(btn,fold);
    }
    const [btn,fold]=row.children, open=expanded.has(key), items=fold.firstChild.firstChild;
    btn.dataset.branch=key;
    btn.querySelector(".chat-label").textContent=name;btn.title=detail;
    btn.querySelector(".chat-count").textContent=count;btn.setAttribute("aria-expanded",String(open));
    fold.inert=!open;fold.classList.toggle("open",open);
    if(open)fill(items);
    return row;
  }
  function submitTransfer(item, recipient, target, name, quiet){
    if(!item || handoffTicket)return;
    if(recipient==="deepseek" && !targets){openSetup();return;}
    if(recipient==="deepseek" && name!==defaultName(item) && !namedHarness){notice("自定义名称需要更新 Harness 接续插件至 0.3.0。");return;}
    quietTransfer=quiet;handoffTicket=++serial;transfer.disabled=true;
    const forkId=family(recipient)===item.source?crypto.randomUUID():undefined;
    post("chatHandoff",{recipient,arg:item.id,text:target,chatTitle:name,forkId,rev:handoffTicket});
  }
  function chooseTarget(item, preferred, recipient=item?.receiver||defaultTarget(item?.source), draft=null){
    if(!item || handoffTicket)return;
    const isHarness=recipient==="deepseek";
    const name=agentName(recipient);
    const canChoosePath=!isHarness || workspacePaths;
    modal("接续对话",(body,actions)=>{
      const close=()=> $("pop").close();
      body.append(el("p","chat-handoff-title",item.title));
      const destination=el("select","chat-handoff-target");
      destination.setAttribute("aria-label","接收智能体");
      for(const key of recipients){
        const option=el("option","",agentName(key));option.value=key;destination.append(option);
      }
      const field=el("input","chat-handoff-target");field.maxLength=120;field.value=draft??defaultName(item);field.setAttribute("aria-label","新对话名称");
      const labelled=(caption,control)=>{const label=el("label","chat-form-label",caption);label.append(control);body.append(label);};
      destination.value=recipient;destination.onchange=()=>chooseTarget(item,null,destination.value,field.value);
      labelled("接收智能体",destination);labelled("新对话名称",field);
      if(isHarness && (!targets || (!targets.length && !workspacePaths))){
        body.append(el("p","",targets
          ?"请先在 Harness 中打开一个工作区，再刷新对话列表。"
          :"打开「管理来源」安装随包提供的接续插件，然后重新打开 Harness 并刷新。"));
        if(!targets)modButton(actions,"管理来源",openSetup);
        modButton(actions,"关闭",close);return;
      }
      const select=el("select","chat-handoff-target");
      select.setAttribute("aria-label","目标工作区");
      const canReuse=canChoosePath && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(item.project);
      const add=(value,text)=>{const opt=el("option","",text);opt.value=value;select.append(opt);};
      if(canChoosePath && item.source==="codex")add("@auto","正在识别实际项目…");
      if(canReuse)add("@source","沿用原工作目录 · "+item.project);
      const folders=entries.filter(e=>e.source===family(recipient) && absoluteFolder(e.project)).map(e=>e.project);
      if(recipient==="antigravitydesktop")folders.push(...desktopFolders);
      const projects=isHarness?targets:Array.from(new Set(folders),path=>({id:"@folder:"+path,title:leaf(path),path}));
      for(const t of projects){
        const opt=el("option","",t.title+" · "+t.path);opt.value=t.id;select.append(opt);
      }
      if(canChoosePath)add("@pick","选择本机其他文件夹…");
      const match=projects.find(t=>t.path===(preferred || (!canReuse && item.project)));
      if(match)select.value=match.id;
      const hint=el("p","chat-handoff-scope");
      const update=()=>{
        hint.textContent=select.value==="@auto" ? (select.autoHint || "正在核对文件修改和命令的工作目录。")
          : select.value==="@source"
          ? name+" 会在这个目录继续工作，可以直接读取其中现有的文件。"
          : select.value==="@pick" ? "下一步选择文件夹，"+name+" 会在该目录接续。"
          : "原话将接续到所选工作区，文件读取从该目录开始。";
      };
      labelled("工作区",select);body.append(hint);
      modButton(actions,"取消",close);
      const submit=modButton(actions,"创建接续副本",()=>{
        close();submitTransfer(item,recipient,select.value==="@auto"?"@folder:"+select.autoPath:select.value,field.value.trim(),false);
      },true);
      const sync=()=>{update();submit.disabled=!field.value.trim() || (select.value==="@auto"&&!select.autoPath);};
      field.oninput=sync;
      select.onchange=sync;sync();
      if(select.querySelector('option[value="@auto"]')){
        const ticket=++serial;
        select.dataset.lookup=String(ticket);
        select.showWorkspace=w=>{
          const option=select.querySelector('option[value="@auto"]');
          if(w?.path){
            select.autoPath=w.path;
            option.textContent=(w.inferred?"实际操作的项目 · ":"沿用会话工作目录 · ")+w.path;
            select.autoHint=w.inferred?"近期成功操作中，此项目有 "+w.edits+" 项文件变更、"+w.commands+" 次命令执行。":"操作记录尚不足以确定其他项目，默认沿用会话目录。";
            if(!w.inferred && canReuse)select.querySelector('option[value="@source"]').remove();
          }else{
            option.remove();
          }
          sync();
        };
        post("chatRead",{arg:item.id,rev:ticket,text:JSON.stringify({format:"workspace"})});
      }
    },"paper");
  }
  // Keep ordinary clicks and touch scrolling. Mouse users can carry a row to a branch.
  let drag=null, suppressClick=false;
  for(const area of [nav,pane])area.addEventListener("pointerdown",e=>{
    const item=e.target.closest(".chat-item,.chat-recent");
    if(item && e.button===0 && e.pointerType==="mouse")
      drag={item,id:e.pointerId,x:e.clientX,y:e.clientY,active:false,over:null};
  });
  function destinationFor(element){
    const b=element?.closest(".chat-branch,.chat-item,.chat-recent");
    if(!b)return null;
    if(b.chat)return {b,recipient:b.chat.receiver||defaultTarget(b.chat.source),path:b.chat.project,chat:b.chat};
    const key=b.dataset.branch;
    if(recipients.includes(defaultTarget(key)))return {b,recipient:defaultTarget(key)};
    if(b.classList.contains("project")){
      const [src,path]=JSON.parse(key);
      if((src==="deepseek" && targets?.some(t=>t.path===path)) ||
          (src!=="deepseek" && recipients.includes(defaultTarget(src)) && absoluteFolder(path)))return {b,path,recipient:defaultTarget(src)};
    }
    return null;
  }
  function dropTarget(e){return destinationFor(document.elementFromPoint(e.clientX,e.clientY));}
  function quickTransfer(item,dest){
    if(!dest || !item)return;
    let path=dest.path;
    const harness=dest.recipient==="deepseek";
    const known=harness && targets?.find(t=>t.path===path || t.id===path);
    if(path && !known && !absoluteFolder(path)){notice("目标会话没有本机工作目录，可使用「接续…」指定。");return;}
    const target=known?known.id:path?"@folder:"+path:item.source==="codex"?"@auto":"@source";
    submitTransfer(item,dest.recipient,target,defaultName(item),true);
  }
  window.addEventListener("pointermove",e=>{
    if(!drag || e.pointerId!==drag.id || !(e.buttons&1))return;
    if(!drag.active){
      if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;
      drag.active=true;drag.item.setPointerCapture(e.pointerId);nav.classList.add("transferring");
    }
    const dest=dropTarget(e);
    if(drag.over!==dest?.b){
      clearTimeout(drag.expandTimer);
      drag.over?.classList.remove("handoff-over");dest?.b.classList.add("handoff-over");drag.over=dest?.b;
      const key=dest?.b.dataset.branch;
      if(key && recipients.includes(defaultTarget(key)) && !expanded.has(key)){
        drag.expandTimer=setTimeout(()=>{expanded.add(key);drawTree();},450);
      }
    }
  });
  function finishDrag(e){
    if(!drag || e.pointerId!==drag.id)return;
    const d=drag;drag=null;
    clearTimeout(d.expandTimer);
    d.over?.classList.remove("handoff-over");nav.classList.remove("transferring");
    if(!d.active)return;
    suppressClick=true;setTimeout(()=>{suppressClick=false;},0);
    if(d.item.hasPointerCapture(e.pointerId))d.item.releasePointerCapture(e.pointerId);
    const dest=e.type==="pointerup" && dropTarget(e);
    if(dest)quickTransfer(d.item.chat,dest);
    else if(e.type==="pointerup" && document.elementFromPoint(e.clientX,e.clientY)?.closest(".chat-branch"))
      notice("请拖到接收智能体、工作区或目标对话。");
  }
  window.addEventListener("pointerup",finishDrag);
  window.addEventListener("pointercancel",finishDrag);
  window.addEventListener("blur",()=>{clearTimeout(drag?.expandTimer);drag?.over?.classList.remove("handoff-over");nav.classList.remove("transferring");drag=null;});
  for(const area of [nav,pane])area.addEventListener("click",e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();}},true);

  function renameChat(item){
    modal("重命名对话",(body,actions)=>{
      const label=el("label","chat-form-label","资料库名称"), field=el("input","chat-handoff-target");
      field.value=item.title;field.maxLength=120;label.append(field);body.append(label);
      modButton(actions,"取消",()=>$("pop").close());
      const save=modButton(actions,"保存",()=>{
        if(!field.value.trim())return;
        post("chatRename",{arg:item.id,text:field.value.trim(),rev:++serial});$("pop").close();
      },true);
      field.oninput=()=>{save.disabled=!field.value.trim();};
      field.onkeydown=e=>{if(e.key==="Enter" && !e.isComposing){e.preventDefault();save.click();}};
      requestAnimationFrame(()=>{field.focus();field.select();});
    });
  }
  const clipboardPrefix="markcraft://conversation/";
  let localCopy="", context=null;
  async function copyChat(item){
    const locator=clipboardPrefix+item.id;
    try{await navigator.clipboard.writeText(locator);localCopy=locator;notice("已复制对话，可粘贴到目标智能体或工作区。");}
    catch{localCopy=locator;notice("已复制到当前窗口，可在目标上粘贴。");}
  }
  async function pasteChat(dest){
    let text;try{text=await navigator.clipboard.readText();}catch{text=localCopy;}
    const source=text?.startsWith(clipboardPrefix) && entries.find(row=>row.id===text.slice(clipboardPrefix.length));
    if(!source){notice("请先在资料库中复制一段可读取的对话。");return;}
    quickTransfer(source,dest);
  }
  function closeChatMenu(returnFocus=false){
    if(!context)return;
    const {menu,row}=context;context=null;menu.remove();
    if(returnFocus && row.isConnected)row.focus({preventScroll:true});
  }
  function openChatMenu(e,row){
    const dest=destinationFor(row),item=row.chat;
    if(!dest && !item)return;
    e.preventDefault();closeChatMenu();closeMenu();
    const menu=el("div","chat-management-menu");menu.setAttribute("role","menu");
    const option=(label,shortcut,run)=>{
      const b=button("",label,()=>{closeChatMenu(true);run();});b.setAttribute("role","menuitem");
      if(shortcut)b.append(el("kbd","",shortcut));menu.append(b);
    };
    if(item){
      option(item.source==="codex"?"在 Codex 窗口打开":item.source==="claude"?"在 Claude Code 窗口打开":"在智能体终端窗口打开","",()=>post("chatOpenNative",{arg:item.id}));
      option("接续到…","",()=>chooseTarget(item));
      option("重命名","F2",()=>renameChat(item));
      option("复制对话","Ctrl+C",()=>copyChat(item));
    }
    const project=item?.project || dest?.path;
    if(absoluteFolder(project))option("复制工作目录","",async()=>{
      try{await navigator.clipboard.writeText(project);notice("已复制工作目录");}
      catch{notice("无法访问剪贴板，可在阅读区选择并复制路径。");}
    });
    if(dest)option("粘贴为接续会话","Ctrl+V",()=>pasteChat(dest));
    document.body.append(menu);context={menu,row};
    const bounds=row.getBoundingClientRect(),x=e.clientX||bounds.left,y=e.clientY||bounds.bottom;
    menu.style.left=Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-4))+"px";
    menu.style.top=Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-4))+"px";
    menu.firstElementChild.focus({preventScroll:true});
    menu.onkeydown=key=>{
      const buttons=[...menu.children],idx=buttons.indexOf(document.activeElement);
      if(key.key==="Escape"){key.preventDefault();closeChatMenu(true);}
      else if(["ArrowUp","ArrowDown"].includes(key.key)){
        key.preventDefault();buttons[(idx+(key.key==="ArrowUp"?-1:1)+buttons.length)%buttons.length].focus();
      }else if(key.key==="Tab")closeChatMenu(true);
    };
  }
  for(const area of [nav,pane]){
    area.addEventListener("contextmenu",e=>{
      const row=e.target.closest(".chat-item,.chat-recent,.chat-branch");if(row)openChatMenu(e,row);
    });
    area.addEventListener("keydown",e=>{
      const row=e.target.closest(".chat-item,.chat-recent,.chat-branch");
      if(!row || e.altKey || e.shiftKey || e.isComposing)return;
      const dest=destinationFor(row),key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
      if(key==="f2" && row.chat && !mod)renameChat(row.chat);
      else if(mod && key==="c" && row.chat)void copyChat(row.chat);
      else if(mod && key==="v" && dest)void pasteChat(dest);
      else return;
      e.preventDefault();e.stopPropagation();
    });
  }
  window.addEventListener("pointerdown",e=>{if(context && !context.menu.contains(e.target))closeChatMenu();},true);
  window.addEventListener("blur",()=>closeChatMenu());window.addEventListener("resize",()=>closeChatMenu());
  function drawTree() {
    reconcile(nav,sources.filter(s=>allowed.includes(s.key)),s=>s.key,(row,src)=>{
      const items=entries.filter(e=>e.source===src.key);
      return group(row,src.key,src.name,()=>mark(src),"source",items.length,src.name,projects=>{
        const destinations=src.key==="deepseek" ? targets || [] : src.key==="antigravity"?desktopFolders.map(path=>({path})):[];
        if(!items.length && !destinations.length){
          if(!projects.querySelector(".chat-no-items"))projects.replaceChildren(el("p","chat-no-items",src.hint));
          return;
        }
        const grouped=new Map();
        for(const item of items){
          if(!grouped.has(item.project))grouped.set(item.project,[]);
          grouped.get(item.project).push(item);
        }
        for(const t of destinations)if(!grouped.has(t.path))grouped.set(t.path,[]);
        reconcile(projects,[...grouped],([project])=>project,(projectRow,[project,chats])=>{
          const key=JSON.stringify([src.key,project]);
          return group(projectRow,key,project,()=>toolIcon("folder"),"project",chats.length,project,list=>{
            reconcile(list,chats,c=>c.id,(chatRow,item)=>{
              if(!chatRow){
                chatRow=button("chat-item","",()=>openChat(chatRow.chat));
                chatRow.append(toolIcon("chat"),el("span","chat-label"));
              }
              chatRow.chat=item;chatRow.lastChild.textContent=item.title;chatRow.title=item.title;
              chatRow.setAttribute("aria-current",String(item.id===selected));return chatRow;
            });
          });
        });
      });
    });
  }
  function home(){
    pendingExport=null;
    $("exportMenuButton").disabled=visible;
    transfer.hidden=true;raw.replaceChildren();
    snapshot=null;resetOutline();newer.hidden=true;document.body.classList.remove("chat-document");
    selected="";readTicket=++serial;reading=false;generation=0;total=0;
    controls.hidden=true;copy.hidden=true;older.hidden=true;raw.hidden=true;alert.hidden=true;transcript.hidden=false;
    title.textContent="最近对话";subtitle.textContent="按本机记录的更新时间排列";
    const list=el("div","chat-recents");
    for(const item of entries.slice(0,12)){
      const src=sourceOf(item),b=button("chat-recent","",()=>openChat(item)),body=el("span","chat-recent-body");
      body.append(el("strong","",item.title),el("small","",src.name+" · "+item.project));b.title=item.project;
      b.chat=item;b.append(mark(src),body,el("time","",dateOf(item.modified/1000)));list.append(b);
    }
    if(!entries.length)list.append(el("p","chat-empty",scanning?"正在查找本机记录…":"暂无对话。请在「管理来源」选择记录目录，或先在智能体中创建一段对话。"));
    transcript.replaceChildren(list);document.body.classList.remove("chat-picked");scroll.scrollTop=0;drawOutline();
  }
  function updateHeading(item){
    transfer.hidden=false;
    const src=sourceOf(item);title.textContent=item.title;title.title=item.title;
    subtitle.textContent=src.name+(total?" · "+total+" 条消息":"")+" · "+item.project;subtitle.title=item.project;
    controls.hidden=false;copy.hidden=mode!=="markdown";copy.disabled=!snapshot;
    $("exportMenuButton").disabled=visible && !!pendingExport;
    document.body.classList.toggle("chat-document",visible && mode==="markdown" && !!snapshot);
    dialogBtn.setAttribute("aria-pressed",String(mode==="dialog"));mdBtn.setAttribute("aria-pressed",String(mode==="markdown"));
  }
  function openChat(item){
    const changed=selected!==item.id;
    selected=item.id;expanded.add(item.source);expanded.add(JSON.stringify([item.source,item.project]));
    if(changed){pendingExport=null;resetOutline();newer.hidden=true;snapshot=null;generation=0;total=0;first=0;synced="";drawnMode="";positions.dialog=positions.markdown=0;transcript.replaceChildren();raw.textContent="";older.hidden=true;}
    drawTree();document.body.classList.add("chat-picked");updateHeading(item);
    requestOutline();drawOutline();load({});
  }
  function changeMode(next){
    if(next===mode||!active())return;
    if(prefs.side==="chatOutline" && !pendingAnchor)pendingAnchor=anchorAtScroll();
    positions[mode]=scroll.scrollTop;mode=next;pinnedTop=null;
    updateHeading(active());
    load(pendingAnchor && next==="dialog" ? {around:Number(pendingAnchor.split(":")[0])} : {});
  }
  function scan(){
    if(!visible||scanning)return;scanning=true;indexTicket=++serial;refresh.setAttribute("aria-busy","true");
    post("chatIndex",{rev:indexTicket});
  }
  function load(opts){
    const item=active();if(!item)return;
    reading=true;wanted=item.modified+"/"+item.size;readTicket=++serial;
    readKind=opts.around!==undefined?"jump":opts.before!==undefined?"older":opts.after!==undefined?"newer":opts.since!==undefined?"append":"show";
    const format=mode==="markdown"?"markdown":"dialog"; raw.hidden=format!=="markdown";transcript.hidden=!raw.hidden;
    if(format==="markdown"){older.hidden=true;newer.hidden=true;}
    if(!generation){alert.hidden=false;alert.textContent="正在读取对话…";}
    post("chatRead",{arg:selected,rev:readTicket,text:JSON.stringify({generation,format,...opts})});
  }
  function newMessage(row,index){
    const user=row.role==="user",block=el("article","chat-turn "+(user?"user":"assistant"));
    block.dataset.index=index;block.messageData=row;const meta=el("div","chat-byline");
    if(!user)meta.append(mark(sourceOf(active())));
    meta.append(el("strong","",user?"我":sourceOf(active()).name),el("time","",dateOf(row.time)));
    const contentBox=el("div","chat-copy");contentBox.innerHTML=row.html;
    // Links in dialogue bubbles remain inert. The Markdown reader owns link navigation.
    for(const a of contentBox.querySelectorAll("a[href]"))a.removeAttribute("href");
    tagAnchors(block,contentBox,index,false);
    block.append(meta,contentBox);return block;
  }
  function receive(m){
    if(m.kind==="chatOpenNative"){if(m.error)notice(m.error);return true;}
    if(["chatSetup","chatConfigure","chatInstallPlugin","chatFolder"].includes(m.kind)){
      if(m.rev===setupTicket && $("pop").open && $("pop").dataset.kind==="chat-setup")applySetup?.(m);
      if(m.kind==="chatConfigure" && !m.error){scanning=false;scan();}
      return true;
    }
    if(m.kind==="chatRename"){
      if(m.error){notice(m.error);return true;}
      const row=entries.find(e=>e.id===m.id);
      if(row){row.title=m.title;drawTree();if(!active())home();else if(row.id===selected){updateHeading(row);if(mode==="markdown")load({});}}
      notice("已更新资料库名称");return true;
    }
    if(m.kind==="chatRead"){
      if(pendingExport && m.rev===pendingExport.rev){
        const {id,format}=pendingExport;
        pendingExport=null;
        if(visible && selected===id && active()){
          $("exportMenuButton").disabled=false;
          if(m.error)notice(m.error);
          else if(m.id===id)exportDoc(format,{title:active().title,text:m.markdown,sections:m.sections});
        }
        return true;
      }
      const picker=$("pop").open && $("pop").querySelector(".chat-handoff-target[data-lookup]");
      if(picker && picker.dataset.lookup===String(m.rev)){picker.showWorkspace(m.workspace);return true;}
    }
    if(m.kind==="chatHandoff"){
      if(m.rev===handoffTicket){
        handoffTicket=0;transfer.disabled=false;
        if(m.cancelled)return true;
        notice(m.error ? "接续失败 · "+m.error : (m.existing?"已有相同副本":"已接续 "+m.count+" 条原话")+" · "+leaf(m.workspace));
        if(!m.error){
          const dest=m.recipient || "deepseek";
          expanded.add(family(dest));expanded.add(JSON.stringify([family(dest),m.workspace]));scan();
          if(dest==="antigravitydesktop"){
            if(quietTransfer)notice("已接续到 Antigravity 桌面端 · "+leaf(m.workspace)+"。项目列表未更新时可重开桌面端。");
            else modal("已接续到 Antigravity 桌面端",(body,actions)=>{
              body.append(el("p","chat-handoff-title",m.title),el("p","",m.workspace),
                el("p","chat-handoff-scope","打开桌面端，在此项目下即可继续。若应用已经打开且列表尚未更新，请退出后重新打开。"));
              modButton(actions,"关闭",()=>$("pop").close());modButton(actions,"打开桌面端",()=>{post("chatOpenAntigravity");$("pop").close();},true);
            });
          }
          if(!quietTransfer && ["claude","codex","antigravity"].includes(dest))modal("在 "+agentName(dest)+" 中继续",(body,actions)=>{
            body.append(el("p","","可在该项目中运行以下 PowerShell 命令。"));
            const command="Set-Location -LiteralPath '"+m.workspace.replaceAll("'","''")+"'\n"+({codex:"codex resume ",claude:"claude --resume ",antigravity:"agy --conversation "}[dest])+m.nativeId;
            const field=el("textarea","chat-handoff-target");field.readOnly=true;field.rows=3;field.value=command;
            field.setAttribute("aria-label","恢复会话命令");body.append(field);
            modButton(actions,"关闭",()=>$("pop").close());
            modButton(actions,"复制命令",async()=>{try{await navigator.clipboard.writeText(command);notice("已复制命令");}catch{field.select();}});
            modButton(actions,"在窗口打开",()=>post("chatOpenNative",{recipient:dest,arg:m.nativeId,text:"received"}),true);
          },"paper");
        }
      }
      return true;
    }
    if(m.kind!=="chatIndex"&&m.kind!=="chatRead")return false;
    if(!visible)return true;
    if(m.kind==="chatIndex"){
      if(m.rev!==indexTicket)return true;
      scanning=false;refresh.removeAttribute("aria-busy");
      if(m.error){entries=[];allowed=[];recipients=[];targets=null;indexKey=null;drawTree();home();alert.textContent=m.error;alert.hidden=false;return true;}
      allowed=m.allowed||[];
      if(!m.configured&&!prompted&&!$("pop").open)openSetup();
      targets=m.handoffTargets || null;
      recipients=m.recipients || [];
      workspacePaths=m.workspacePaths===true;
      namedHarness=m.namedHarness===true;desktopFolders=m.desktopFolders||[];
      const key=JSON.stringify([allowed,m.entries,targets,desktopFolders]);
      if(key!==indexKey){
        const priorTitle=active()?.title;
        indexKey=key;entries=m.entries;drawTree();
        if(!active())home();else updateHeading(active());
        if(active() && mode==="markdown" && priorTitle!==active().title)load({});
      }
      requestOutline();
      if(active()&&!reading&&synced!==active().modified+"/"+active().size){
        const end=lastMessage()+1;
        load(mode==="dialog" && end>0 && end<total ? {before:end} : generation?{since:total}:{});
      }
      return true;
    }
    if(m.rev===outlineTicket && m.id===selected){
      outlineLoading=false;
      if(m.error){outlineError=m.error;outlineKey="";outlineRows=[];}
      else outlineRows=indexOutline(m.outline);
      drawOutline();return true;
    }
    if(m.rev!==readTicket||m.id!==selected)return true;
    reading=false;
    if(m.error){pendingAnchor="";alert.textContent=m.error;alert.hidden=false;synced="";return true;}
    synced=wanted;
    const oldTop=scroll.scrollTop,oldHeight=scroll.scrollHeight,atBottom=oldHeight-scroll.clientHeight-oldTop<70;
    const olderPage=readKind==="older" && generation===m.generation && m.start<first && transcript.childElementCount>0;
    const switched=drawnMode!==mode;
    if(mode==="markdown"){
      const sections=m.sections;
      sections.forEach((html,i)=>{
        let section=raw.children[i];
        if(section?.sourceHtml===html)return;
        if(!section){section=el("section",i?"chat-md-turn":"chat-md-title");raw.append(section);}
        section.sourceHtml=html;section.innerHTML=html;
        if(i>0)tagAnchors(section,section,i-1,true);
        void typeset(section,diagramPalette(),false);
      });
      while(raw.children.length>sections.length)raw.lastElementChild.remove();
      snapshot={title:active().title,text:m.markdown,sections};
    }else{
      if(readKind==="jump" || generation!==m.generation || !transcript.firstElementChild || m.start>lastMessage()+1){
        transcript.replaceChildren();first=m.start;
      }
      const frag=document.createDocumentFragment(),existing=new Map(Array.from(transcript.children,n=>[Number(n.dataset.index),n]));
      m.rows.forEach((row,i)=>{
        const idx=m.start+i,prev=existing.get(idx);
        if(prev){
          const old=prev.messageData;
          if(old.text!==row.text || old.role!==row.role || old.time!==row.time)prev.replaceWith(newMessage(row,idx));
        }else if(olderPage || idx>=first)frag.append(newMessage(row,idx));
      });
      if(olderPage){transcript.prepend(frag);first=m.start;}else transcript.append(frag);
      while(transcript.lastElementChild && Number(transcript.lastElementChild.dataset.index)>=m.total){
        transcript.lastElementChild.remove();
      }
      newer.hidden=lastMessage()+1>=m.total;
      newer.textContent="查看后续的 "+Math.min(40,m.total-lastMessage()-1)+" 条消息";
      older.hidden=first===0;older.textContent="查看更早的 "+Math.min(40,first)+" 条消息";
    }
    total=m.total;generation=m.generation;updateHeading(active());
    alert.textContent=total?"":"这段记录还没有用户或助手发言。";alert.hidden=!!total;
    anchorNodes=Array.from((mode==="markdown"?raw:transcript).querySelectorAll("[data-chat-anchor]"));
    const go=pendingAnchor;pendingAnchor="";
    if(!go || !(locate(go) || locate(go.split(":")[0]))){
      if(olderPage)scroll.scrollTop=oldTop+(scroll.scrollHeight-oldHeight);
      else if(switched)scroll.scrollTop=positions[mode];
      else if(readKind!=="newer" && atBottom)scroll.scrollTop=scroll.scrollHeight;
      else scroll.scrollTop=oldTop;
    }
    drawnMode=mode;
    if(prefs.side==="chatOutline" && scroll.clientHeight)markAnchor(anchorAtScroll());
    return true;
  }
  function switchSide(which,old){
    const on=which==="chats" || which==="chatOutline" || (!which && visible);
    const showLibrary=which==="chats";
    const filter=$("outlineFilter");
    filter.placeholder=which==="chatOutline"?"筛选提问、回复和标题":"筛选标题";
    filter.setAttribute("aria-label",which==="chatOutline"?"筛选对话大纲":"筛选大纲标题");
    if(old==="chatOutline" && which!==old){
      chatFilter=$("outlineFilter").value;$("outlineFilter").value=fileFilter;
    }else if(which==="chatOutline" && which!==old){
      fileFilter=$("outlineFilter").value;$("outlineFilter").value=chatFilter;
    }
    if(which==="chats" || which==="chatOutline")lastSide=which;
    tab.classList.toggle("current",showLibrary);tab.setAttribute("aria-pressed",String(showLibrary));
    side.hidden=!showLibrary;
    picker.textContent=lastSide==="chatOutline"?"‹ 对话大纲":"‹ 对话列表";
    if(visible && on && which && which!==old)document.body.classList.remove("chat-picked");
    if(on===visible){
      if(which==="chatOutline"){
        if(scroll.clientHeight)markAnchor(anchorAtScroll());
        requestOutline();
      }
      if(!which && on)document.body.classList.add("chat-picked");
      return;
    }
    if(!on){handoffTicket=0;transfer.disabled=false;}
    visible=on;pane.hidden=!on;$("desk").hidden=on;document.body.classList.toggle("chat-reading",on);
    clearInterval(timer);
    closeMenu();
    if(on){
      scanning=false;reading=false;
      if(!active())home();else{updateHeading(active());load({});requestOutline();}
      scan();timer=setInterval(()=>{if(!document.hidden)scan();},3000);
      (showLibrary?tab:$("outlineTab")).focus({preventScroll:true});
    }else{
      pendingExport=null;$("exportMenuButton").disabled=false;
      document.body.classList.remove("chat-picked","chat-document");
      indexTicket=++serial;readTicket=++serial;outlineTicket=++serial;outlineKey="";pendingAnchor="";
    }
  }
  window.addEventListener("focus",scan);document.addEventListener("visibilitychange",()=>{if(!document.hidden)scan();});
  function command(cmd) {
    if(!visible || !active())return false;
    const format=cmd==="save" || cmd==="saveAs" ? "exportMarkdown" : cmd;
    if(!["exportMarkdown","exportPdf","docx","print","exportHtml","epub","odt","rtf","latex"].includes(format))return false;
    closeMenu();
    if(pendingExport || exporting)return true;
    // The dialog renders one page at a time. Export from the full conversation.
    const rev=++serial;
    pendingExport={id:selected,format,rev};
    $("exportMenuButton").disabled=true;
    post("chatRead",{arg:selected,rev,text:JSON.stringify({format:"markdown"})});
    return true;
  }
  return {receive,switchSide,command,drawOutline,openSetup,
    get isReading(){return visible;}, get restoreSide(){return visible?lastSide:"";}
  };
})();
