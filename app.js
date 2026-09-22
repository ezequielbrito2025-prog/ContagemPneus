(function(){
"use strict";

/* ================= constants ================= */
var CATEGORIES = ["Pneu novo","Pneu conserto","Pneu recapado"];
var CAT_DOTS = {"Pneu novo":"var(--ok)","Pneu conserto":"var(--warn)","Pneu recapado":"var(--accent)"};

/* ================= state =================
   Os dados moram no servidor (dados/store.json, no computador que roda "node server.js").
   Este app é um cliente: carrega o estado por Server-Sent Events (/api/events) e manda
   toda alteração por POST para a API — assim todo mundo na mesma rede vê tudo em tempo real. */
var store = null;            // { users:[], warehouses:[], suppliers:[], materials:[], movements:[], dailyCounts:{} }
var currentUser = null;      // {username, role}
var materials = [];
var movements = [];
var warehouses = [];
var suppliers = [];
var users = [];
var currentPage = "dashboard";
var seedBannerDismissed = false;
var evtSource = null;
var firstStateLoaded = false;
var countInputTimers = {};
// Dois almoxarifados físicos separados (Dois Irmãos / Muribeca). Cada operador é travado em um só;
// o admin enxerga todos e pode alternar entre eles (ou ver "Todos" combinado) por um seletor
// no topo da tela. activeWarehouseId decide o que as telas do dia a dia (Painel, Estoque,
// Movimentação, Contagem, Histórico) mostram e em qual almoxarifado uma nova movimentação é lançada.
var ALL_WAREHOUSES = '__all__';
var activeWarehouseId = null;

try { seedBannerDismissed = localStorage.getItem('tireapp_seed_dismissed') === '1'; } catch(e){}

/* ================= helpers ================= */
function qs(id){ return document.getElementById(id); }
function esc(s){
  s = (s===undefined||s===null) ? "" : String(s);
  return s.replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; });
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,10); }
function todayStr(){
  var d = new Date();
  var m = String(d.getMonth()+1).padStart(2,'0');
  var day = String(d.getDate()).padStart(2,'0');
  return d.getFullYear()+"-"+m+"-"+day;
}
function fmtDate(iso){
  if(!iso) return "—";
  var parts = iso.split('-');
  if(parts.length!==3) return iso;
  return parts[2]+"/"+parts[1]+"/"+parts[0];
}
function fmtDateTime(iso){
  try{
    var d = new Date(iso);
    return fmtDate(d.toISOString().slice(0,10)) + " " + String(d.getHours()).padStart(2,'0')+":"+String(d.getMinutes()).padStart(2,'0');
  }catch(e){ return iso||"—"; }
}
function toast(msg){
  var t = qs('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(function(){ t.classList.remove('show'); }, 2600);
}
function warehouseName(id){ var w = warehouses.find(function(x){return x.id===id;}); return w ? w.name : "—"; }
function supplierNameById(id){ var s = suppliers.find(function(x){return x.id===id;}); return s ? s.name : ""; }
function materialById(id){ return materials.find(function(x){return x.id===id;}); }

/* ================= acesso por almoxarifado ================= */
function isAdmin(){ return !!(currentUser && currentUser.role === 'admin'); }
/* Almoxarifados que este usuário pode ver/escolher: o admin vê todos; o operador só o próprio. */
function visibleWarehouses(){
  if(isAdmin()) return warehouses;
  return warehouses.filter(function(w){ return w.id === (currentUser && currentUser.warehouseId); });
}
/* Materiais dentro do "escopo" atualmente selecionado (o que as telas do dia a dia mostram). */
function materialsInScope(){
  if(isAdmin()){
    if(activeWarehouseId === ALL_WAREHOUSES) return materials;
    return materials.filter(function(m){ return m.warehouseId === activeWarehouseId; });
  }
  return materials.filter(function(m){ return m.warehouseId === (currentUser && currentUser.warehouseId); });
}
function movementsInScope(){
  if(isAdmin()){
    if(activeWarehouseId === ALL_WAREHOUSES) return movements;
    return movements.filter(function(m){ return m.warehouseId === activeWarehouseId; });
  }
  return movements.filter(function(m){ return m.warehouseId === (currentUser && currentUser.warehouseId); });
}
/* Preenche/atualiza o seletor de almoxarifado no topo da tela: para o admin é um <select> de
   verdade (com "Todos os almoxarifados" + cada um); para o operador é fixo no almoxarifado dele. */
function renderWarehouseSwitcher(){
  var el = qs('whSwitcher');
  if(!el || !currentUser) return;
  if(isAdmin()){
    var valid = activeWarehouseId === ALL_WAREHOUSES || warehouses.find(function(w){ return w.id === activeWarehouseId; });
    if(!valid) activeWarehouseId = ALL_WAREHOUSES;
    el.innerHTML = '<option value="'+ALL_WAREHOUSES+'">🏬 Todos os almoxarifados</option>' +
      warehouses.map(function(w){ return '<option value="'+w.id+'">🏬 '+esc(w.name)+'</option>'; }).join('');
    el.disabled = false;
    el.value = activeWarehouseId;
  } else {
    activeWarehouseId = currentUser.warehouseId;
    var mine = warehouses.find(function(w){ return w.id === currentUser.warehouseId; });
    el.innerHTML = '<option value="'+(mine?mine.id:'')+'">🏬 '+esc(mine?mine.name:'—')+'</option>';
    el.disabled = true;
    el.value = mine ? mine.id : '';
  }
}

/* ================= modal ================= */
function openModal(html, onMount){
  var root = qs('modalRoot');
  root.innerHTML = '<div class="modal-backdrop" id="mb"><div class="modal">'+html+'</div></div>';
  var mb = qs('mb');
  mb.addEventListener('mousedown', function(e){ if(e.target===mb) closeModal(); });
  if(onMount) onMount(root);
}
function closeModal(){ qs('modalRoot').innerHTML=''; }

/* ================= servidor: API + tempo real (SSE) =================
   apiPost() manda a alteração para o servidor; o próprio servidor recalcula
   quantidades, valida e — se der certo — avisa TODOS os navegadores conectados
   (inclusive este) por Server-Sent Events com o estado novo completo. Por isso
   as funções de tela abaixo não mexem em "materials"/"movements" diretamente:
   elas só mandam o pedido e esperam a atualização chegar por connectRealtime(). */
async function apiPost(path, body){
  try{
    var res = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
    return await res.json();
  }catch(err){
    return {ok:false, error:'Não foi possível falar com o servidor. Verifique se o computador do servidor está ligado e se este dispositivo está na mesma rede.'};
  }
}

function applyServerState(newStore){
  store = newStore;
  materials = store.materials || [];
  movements = store.movements || [];
  warehouses = store.warehouses || [];
  suppliers = store.suppliers || [];
  users = store.users || [];
  if(!store.dailyCounts) store.dailyCounts = {};
}

function setConnected(ok){
  var el = qs('connBadge');
  if(!el) return;
  if(ok){
    el.textContent = '🟢 Online — mesma rede';
    el.className = 'conn-on';
    el.title = 'Conectado ao servidor. As alterações aparecem em tempo real para todos os dispositivos.';
  } else {
    el.textContent = '🔴 Sem conexão com o servidor';
    el.className = 'conn-off';
    el.title = 'Não foi possível falar com o servidor agora. Tentando reconectar automaticamente…';
  }
}

function onFirstStateLoaded(){
  firstStateLoaded = true;
  var btn = qs('loginBtn');
  if(btn){ btn.disabled = false; btn.textContent = 'Entrar'; }
  var notice = qs('storageNotice');
  if(notice) notice.hidden = true;
  if(currentUser){ renderAll(); }
}

function connectRealtime(){
  if(evtSource){ try{ evtSource.close(); }catch(e){} evtSource = null; }
  try{ evtSource = new EventSource('/api/events'); }
  catch(err){ console.error(err); setConnected(false); return; }

  evtSource.onopen = function(){ setConnected(true); };
  evtSource.onmessage = function(ev){
    setConnected(true);
    var data;
    try{ data = JSON.parse(ev.data); }catch(e){ return; }
    if(data && data.unauthenticated){
      // Essa conexão não está logada. Se o app achava que estava logado (ex: o servidor
      // reiniciou e "esqueceu" a sessão), volta pra tela de login em vez de mostrar tudo vazio.
      if(currentUser){ doLogout('Sua sessão expirou. Faça login novamente.'); }
      if(!firstStateLoaded){ onFirstStateLoaded(); }
      return;
    }
    applyServerState(data);
    if(!firstStateLoaded){ onFirstStateLoaded(); }
    else if(currentUser){ renderAll(); }
  };
  evtSource.onerror = function(){
    setConnected(false);
    if(!firstStateLoaded){
      var notice = qs('storageNotice');
      if(notice){
        notice.textContent = '⚠ Não foi possível conectar ao servidor. Verifique se "iniciar-servidor.bat" está aberto no computador do servidor e se este dispositivo está na mesma rede Wi‑Fi/cabo.';
        notice.hidden = false;
      }
    }
    // o próprio navegador tenta reconectar automaticamente (EventSource); não precisamos fazer nada aqui.
  };
}

/* ================= daily count helpers ================= */
function todayCountMap(){
  var today = todayStr();
  if(!store.dailyCounts) store.dailyCounts = {};
  if(!store.dailyCounts[today]) store.dailyCounts[today] = {};
  return store.dailyCounts[today];
}
function hasCountValue(v){ return v!==undefined && v!==null && v!==''; }

/* ================= render: dashboard ================= */
function renderAll(){
  renderWarehouseSwitcher();
  renderStats();
  renderDashboardPanels();
  renderMaterials();
  renderMovementsToday();
  renderHistory();
  renderWarehouses();
  renderSuppliers();
  renderCount();
  renderCountHistory();
  renderFilters();
  renderUsers();
  renderBackupPage();
}

function renderStats(){
  var mats = materialsInScope(), movs = movementsInScope();
  qs('statItems').textContent = mats.length;
  qs('statUnits').textContent = mats.reduce(function(a,m){return a+Number(m.quantity||0);},0);
  var today = todayStr();
  qs('statToday').textContent = movs.filter(function(m){return m.date===today;}).length;
  var counts = (store.dailyCounts && store.dailyCounts[today]) ? store.dailyCounts[today] : {};
  var countedN = mats.filter(function(m){ return hasCountValue(counts[m.id]); }).length;
  qs('statCount').textContent = countedN + '/' + mats.length;
}

function typePill(t){
  if(t==='entrada') return '<span class="pill pill-in">↓ Entrada</span>';
  if(t==='saida') return '<span class="pill pill-out">↑ Saída</span>';
  if(t==='transferencia') return '<span class="pill pill-transfer">⇄ Transferência</span>';
  return '<span class="pill pill-adj">⚙ Ajuste</span>';
}
function typeLabelText(t){
  if(t==='entrada') return 'Entrada';
  if(t==='saida') return 'Saída';
  if(t==='transferencia') return 'Transferência';
  return 'Ajuste';
}
function movWarehouseLabel(m){
  if(m.type==='transferencia') return esc(m.originWarehouseName||'—') + ' → ' + esc(m.destWarehouseName||'—');
  return esc(m.warehouseName||'—');
}
function movWarehouseLabelText(m){
  if(m.type==='transferencia') return (m.originWarehouseName||'—') + ' → ' + (m.destWarehouseName||'—');
  return m.warehouseName||'—';
}
/* Na Entrada mostramos o fornecedor (de quem recebemos o pneu); nos outros tipos, o ativo
   (equipamento que recebeu o pneu). As duas coisas dividem a mesma coluna nas tabelas. */
function assetOrSupplierText(m){
  if(m.type==='entrada') return m.supplierName || '—';
  return m.asset || '—';
}

/* Gráfico de barras (SVG) com as unidades em estoque por categoria. */
function renderCategoryChart(){
  var byCat = {};
  CATEGORIES.forEach(function(c){ byCat[c]=0; });
  materialsInScope().forEach(function(m){ byCat[m.category] = (byCat[m.category]||0) + Number(m.quantity||0); });
  var values = CATEGORIES.map(function(c){ return byCat[c]||0; });
  var max = Math.max.apply(null, values.concat([1]));

  var W = 560, H = 240, padTop = 30, padBottom = 42, padSide = 20;
  var chartH = H - padTop - padBottom;
  var n = CATEGORIES.length;
  var gap = 30;
  var barW = Math.max(40, Math.min(96, (W - padSide*2 - gap*(n-1)) / n));
  var totalBarsW = barW*n + gap*(n-1);
  var startX = (W - totalBarsW)/2;
  var baseline = padTop+chartH;

  var bars = CATEGORIES.map(function(c, i){
    var v = byCat[c]||0;
    var h = max>0 ? Math.round((v/max)*chartH) : 0;
    if(v>0 && h<3) h = 3;
    var x = startX + i*(barW+gap);
    var y = baseline - h;
    var color = CAT_DOTS[c];
    var shortLabel = c.replace('Pneu ','');
    return '<g>'+
      '<title>'+esc(c)+': '+v+' unidade(s) em estoque</title>'+
      '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+h+'" rx="6" ry="6" style="fill:'+color+'"></rect>'+
      '<text x="'+(x+barW/2).toFixed(1)+'" y="'+(y-10).toFixed(1)+'" text-anchor="middle" style="fill:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;">'+v+'</text>'+
      '<text x="'+(x+barW/2).toFixed(1)+'" y="'+(baseline+22)+'" text-anchor="middle" style="fill:var(--ink-soft);font-size:12px;font-weight:600;">'+esc(shortLabel)+'</text>'+
    '</g>';
  }).join('');

  return '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block;max-height:260px;" role="img" aria-label="Unidades em estoque por categoria de pneu">'+
    '<line x1="'+padSide+'" y1="'+baseline+'" x2="'+(W-padSide)+'" y2="'+baseline+'" style="stroke:var(--border);stroke-width:1;"></line>'+
    bars+
    '</svg>';
}

function renderDashboardPanels(){
  var movBody = qs('dashMovBody');
  var recent = movementsInScope().slice(0,8);
  movBody.innerHTML = recent.length ? recent.map(function(m){
    return '<tr><td class="mono">'+fmtDate(m.date)+'</td><td>'+typePill(m.type)+'</td><td>'+esc(m.materialName)+'</td>'+
      '<td class="mono">'+esc(m.quantity)+'</td><td>'+esc(m.person||'—')+'</td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="5">Sem movimentações ainda.</td></tr>';

  qs('dashCatBody').innerHTML = renderCategoryChart();
}

/* ================= render: materials ================= */
function renderFilters(){
  var catSel = qs('matCatFilter');
  if(catSel.options.length<=1){
    CATEGORIES.forEach(function(c){ var o=document.createElement('option'); o.value=c; o.textContent=c; catSel.appendChild(o); });
  }
  var whSel = qs('matWhFilter');
  var current = whSel.value;
  whSel.innerHTML = '<option value="">Todos os almoxarifados</option>' + visibleWarehouses().map(function(w){return '<option value="'+w.id+'">'+esc(w.name)+'</option>';}).join('');
  whSel.value = current;
}

function getMaterialFilters(){
  return {
    q: qs('matSearch').value.trim().toLowerCase(),
    cat: qs('matCatFilter').value,
    wh: qs('matWhFilter').value
  };
}

function renderMaterials(){
  var scoped = materialsInScope();
  qs('seedBanner').hidden = seedBannerDismissed || scoped.length===0;
  var f = getMaterialFilters();
  var list = scoped.filter(function(m){
    if(f.q && !((m.name||'').toLowerCase().indexOf(f.q)>-1 || (m.code||'').toLowerCase().indexOf(f.q)>-1)) return false;
    if(f.cat && m.category!==f.cat) return false;
    if(f.wh && m.warehouseId!==f.wh) return false;
    return true;
  }).slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
  var body = qs('materialsBody');
  body.innerHTML = list.length ? list.map(function(m){
    return '<tr>'+
      '<td class="mono">'+esc(m.code)+'</td>'+
      '<td>'+esc(m.name)+'</td>'+
      '<td><span class="pill pill-cat"><span class="dot" style="background:'+CAT_DOTS[m.category]+'"></span>'+esc(m.category)+'</span></td>'+
      '<td>'+esc(m.warehouseName)+'</td>'+
      '<td class="mono">'+esc(m.quantity)+'</td>'+
      '<td>'+esc(m.unit)+'</td>'+
      '<td><div class="row-actions"><button class="icon-btn" data-edit-material="'+m.id+'" title="Editar">✎</button></div></td>'+
    '</tr>';
  }).join('') : '<tr class="empty-row"><td colspan="7">Nenhum material encontrado.</td></tr>';
}

/* ================= render: movements today / history ================= */
function renderMovementsToday(){
  var today = todayStr();
  var list = movementsInScope().filter(function(m){return m.date===today;});
  var body = qs('movTodayBody');
  body.innerHTML = list.length ? list.map(function(m){
    return '<tr><td class="mono">'+fmtDateTime(m.createdAt).split(' ')[1]+'</td><td>'+typePill(m.type)+'</td><td>'+esc(m.materialName)+'</td>'+
      '<td class="mono">'+esc(m.quantity)+'</td><td class="mono">'+esc(assetOrSupplierText(m))+'</td><td>'+esc(m.person||'—')+'</td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="6">Nenhuma movimentação hoje ainda. Use os botões acima para registrar.</td></tr>';
}

function getHistoryFilteredList(){
  var q = qs('histSearch').value.trim().toLowerCase();
  var type = qs('histTypeFilter').value;
  var from = qs('histDateFrom').value;
  var to = qs('histDateTo').value;
  return movementsInScope().filter(function(m){
    if(type && m.type!==type) return false;
    if(from && m.date<from) return false;
    if(to && m.date>to) return false;
    if(q){
      var hay = ((m.materialName||'')+' '+(m.asset||'')+' '+(m.supplierName||'')+' '+(m.person||'')).toLowerCase();
      if(hay.indexOf(q)===-1) return false;
    }
    return true;
  });
}

function renderHistory(){
  var list = getHistoryFilteredList();
  var body = qs('historyBody');
  body.innerHTML = list.length ? list.map(function(m){
    return '<tr><td class="mono">'+fmtDate(m.date)+'</td><td>'+typePill(m.type)+'</td><td>'+esc(m.materialName)+' <span class="mono" style="color:var(--ink-faint);">'+esc(m.materialCode)+'</span></td>'+
      '<td class="mono">'+esc(m.quantity)+'</td><td class="mono">'+esc(assetOrSupplierText(m))+'</td><td>'+movWarehouseLabel(m)+'</td>'+
      '<td>'+esc(m.person||'—')+'</td><td>'+esc(m.note||'—')+'</td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="8">Nenhuma movimentação encontrada para esse filtro.</td></tr>';
}

function exportHistoryExcel(){
  var list = getHistoryFilteredList();
  if(list.length===0){ toast('Não há movimentações para exportar com esse filtro.'); return; }
  var header = ['Data','Tipo','Código','Material','Qtd.','Ativo / Fornecedor','Almoxarifado','Responsável','Observação'];
  var rows = list.map(function(m){
    return [fmtDate(m.date), typeLabelText(m.type), m.materialCode||'', m.materialName||'', Number(m.quantity||0),
      assetOrSupplierText(m), movWarehouseLabelText(m), m.person||'', m.note||''];
  });
  try{
    var bytes = buildXlsx('Historico', header, rows);
    var ok = downloadBytes(bytes, 'historico-movimentacoes-'+todayStr()+'.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast(ok ? 'Planilha do histórico baixada.' : 'Não foi possível gerar o Excel neste ambiente.');
  }catch(err){
    console.error(err);
    toast('Não foi possível gerar o Excel neste ambiente.');
  }
}

/* ================= render: daily count (contagem diária) ================= */
function renderCount(){
  var titleEl = qs('countDateLabel');
  if(titleEl) titleEl.textContent = fmtDate(todayStr());

  var searchEl = qs('countSearch');
  var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  var counts = todayCountMap();
  var scopedMats = materialsInScope();

  var list = scopedMats.filter(function(m){
    if(q && !((m.name||'').toLowerCase().indexOf(q)>-1 || (m.code||'').toLowerCase().indexOf(q)>-1)) return false;
    return true;
  }).slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });

  var counted = scopedMats.filter(function(m){ return hasCountValue(counts[m.id]); }).length;
  var progEl = qs('countProgress');
  if(progEl) progEl.textContent = counted + ' de ' + scopedMats.length + ' contados hoje';

  var body = qs('countBody');

  // Se o usuário estiver digitando numa linha da contagem quando chega uma atualização em
  // tempo real (de outro dispositivo, ou da própria digitação deste), não queremos perder o
  // que ele já digitou (ainda não salvo) nem tirar o foco/cursor do campo. Guardamos o valor
  // "ao vivo" do campo ativo e o restauramos depois de recriar a tabela.
  var active = document.activeElement;
  var activeMid = (active && active.classList && active.classList.contains('count-input')) ? active.getAttribute('data-count-material') : null;
  var activeLiveValue = activeMid ? active.value : null;
  var activeSelStart = activeMid ? active.selectionStart : null;
  var activeSelEnd = activeMid ? active.selectionEnd : null;

  body.innerHTML = list.length ? list.map(function(m){
    var raw = counts[m.id];
    var isActiveRow = m.id === activeMid;
    var displayValue = isActiveRow ? activeLiveValue : (hasCountValue(raw)?esc(raw):'');
    var diffSource = isActiveRow ? activeLiveValue : raw;
    return '<tr>'+
      '<td class="mono">'+esc(m.code)+'</td>'+
      '<td>'+esc(m.name)+'</td>'+
      '<td>'+esc(m.warehouseName)+'</td>'+
      '<td class="mono">'+esc(m.quantity)+' '+esc(m.unit)+'</td>'+
      '<td><input type="number" min="0" step="1" inputmode="numeric" class="count-input" data-count-material="'+m.id+'" value="'+esc(displayValue===null?'':displayValue)+'" placeholder="—"></td>'+
      '<td class="mono" data-diff-cell>'+diffPillHtml(diffSource, m.quantity)+'</td>'+
    '</tr>';
  }).join('') : '<tr class="empty-row"><td colspan="6">Nenhum material encontrado.</td></tr>';

  if(activeMid){
    var restored = body.querySelector('[data-count-material="'+activeMid+'"]');
    if(restored){
      restored.focus();
      try{ restored.setSelectionRange(activeSelStart, activeSelEnd); }catch(e){}
    }
  }
}

function diffPillHtml(raw, systemQty){
  if(!hasCountValue(raw)) return '<span style="color:var(--ink-faint);">—</span>';
  var diff = Number(raw) - Number(systemQty||0);
  if(diff===0) return '<span class="pill pill-ok">0</span>';
  return '<span class="pill pill-low">'+(diff>0?'+':'')+diff+'</span>';
}

/* Histórico de contagens: cada dia em que alguém digitou pelo menos um valor na contagem
   fica salvo em store.dailyCounts[data]. Aqui só listamos essas datas para conferir de novo
   ou baixar o Excel de um dia anterior — a edição continua sendo sempre a do dia de hoje. */
function renderCountHistory(){
  var body = qs('countHistoryBody');
  if(!body) return;
  var today = todayStr();
  var dates = Object.keys(store.dailyCounts||{}).filter(function(d){
    var counts = store.dailyCounts[d]||{};
    return Object.keys(counts).length>0 || d===today;
  }).sort().reverse();
  var scopedMats = materialsInScope();
  body.innerHTML = dates.length ? dates.map(function(d){
    var counts = store.dailyCounts[d]||{};
    var countedN = scopedMats.filter(function(m){ return hasCountValue(counts[m.id]); }).length;
    return '<tr><td class="mono">'+fmtDate(d)+(d===today?' <span class="pill pill-in">hoje</span>':'')+'</td>'+
      '<td class="mono">'+countedN+'/'+scopedMats.length+'</td>'+
      '<td><div class="row-actions"><button class="btn btn-secondary btn-sm" data-export-count-date="'+d+'">⬇ Excel</button></div></td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="3">Nenhuma contagem registrada ainda.</td></tr>';
}

/* ================= render: warehouses ================= */
function renderWarehouses(){
  var body = qs('warehousesBody');
  body.innerHTML = warehouses.length ? warehouses.map(function(w){
    var items = materials.filter(function(m){return m.warehouseId===w.id;});
    var units = items.reduce(function(a,m){return a+Number(m.quantity||0);},0);
    return '<tr><td>'+esc(w.name)+'</td><td class="mono">'+items.length+'</td><td class="mono">'+units+'</td>'+
      '<td><div class="row-actions"><button class="icon-btn" data-edit-warehouse="'+w.id+'" title="Renomear">✎</button></div></td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="4">Nenhum almoxarifado cadastrado.</td></tr>';
}

/* ================= render: suppliers (fornecedores) ================= */
function renderSuppliers(){
  var body = qs('suppliersBody');
  if(!body) return;
  body.innerHTML = suppliers.length ? suppliers.slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'');}).map(function(s){
    return '<tr><td>'+esc(s.name)+'</td><td class="mono">'+fmtDate((s.createdAt||'').slice(0,10))+'</td>'+
      '<td><div class="row-actions"><button class="icon-btn" data-edit-supplier="'+s.id+'" title="Renomear">✎</button></div></td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="3">Nenhum fornecedor cadastrado.</td></tr>';
}

/* ================= render: users ================= */
function renderUsers(){
  var body = qs('usersBody');
  if(!body || !currentUser) return;
  body.innerHTML = users.length ? users.slice().sort(function(a,b){return a.username.localeCompare(b.username);}).map(function(u){
    var whLabel = u.role==='admin' ? '<span style="color:var(--ink-faint);">Todos</span>' : esc(warehouseName(u.warehouseId));
    return '<tr><td>'+esc(u.username)+'</td><td><span class="pill pill-role">'+esc(u.role)+'</span></td>'+
      '<td>'+whLabel+'</td>'+
      '<td class="mono">'+fmtDate((u.createdAt||'').slice(0,10))+'</td>'+
      '<td><div class="row-actions">'+
      (u.role!=='admin' ? '<button class="icon-btn" data-change-wh-user="'+esc(u.username)+'" title="Trocar almoxarifado">🏬</button>' : '')+
      '<button class="icon-btn" data-reset-user="'+esc(u.username)+'" title="Redefinir senha">🔑</button>'+
      (u.username!==currentUser.username ? '<button class="icon-btn" data-del-user="'+esc(u.username)+'" title="Remover">🗑</button>' : '')+
      '</div></td></tr>';
  }).join('') : '<tr class="empty-row"><td colspan="5">Nenhum usuário.</td></tr>';
}

/* ================= navigation ================= */
function setPage(page){
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.toggle('active', n.dataset.page===page); });
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
  qs('page-'+page).classList.add('active');
  var titles = {dashboard:'Painel', materials:'Estoque', movements:'Movimentação', count:'Contagem diária', history:'Histórico', warehouses:'Almoxarifados', users:'Usuários', backup:'Backup'};
  qs('pageTitle').textContent = titles[page]||page;
  qs('sidebar').classList.remove('open');
  qs('sidebarScrim').classList.remove('show');
}

/* ================= material add/edit ================= */
function whOptions(selectedId){
  return visibleWarehouses().map(function(w){ return '<option value="'+w.id+'" '+(w.id===selectedId?'selected':'')+'>'+esc(w.name)+'</option>'; }).join('');
}
/* Sempre todos os almoxarifados, independente de quem está vendo — só usada em telas
   estritamente de admin (ex.: trocar o almoxarifado de um operador). */
function whOptionsAll(selectedId){
  return warehouses.map(function(w){ return '<option value="'+w.id+'" '+(w.id===selectedId?'selected':'')+'>'+esc(w.name)+'</option>'; }).join('');
}
function supplierOptions(selectedId){
  return suppliers.map(function(s){ return '<option value="'+s.id+'" '+(s.id===selectedId?'selected':'')+'>'+esc(s.name)+'</option>'; }).join('');
}
function catOptions(selected){
  return CATEGORIES.map(function(c){ return '<option value="'+esc(c)+'" '+(c===selected?'selected':'')+'>'+esc(c)+'</option>'; }).join('');
}

function openMaterialModal(material){
  var editing = !!material;
  var defaultWhId = editing ? material.warehouseId
    : (activeWarehouseId && activeWarehouseId!==ALL_WAREHOUSES ? activeWarehouseId : (visibleWarehouses()[0] && visibleWarehouses()[0].id));
  var html =
    '<h3>'+(editing?'Editar material':'Novo material')+'</h3>'+
    '<div id="matFormError" class="form-error" hidden></div>'+
    '<form id="matForm">'+
      '<div class="field"><label>Nome</label><input id="mName" required value="'+(editing?esc(material.name):'')+'" placeholder="ex: Pneu 185/65 R15"></div>'+
      '<div class="grid2">'+
        '<div class="field"><label>Código</label><input id="mCode" required value="'+(editing?esc(material.code):'')+'" placeholder="ex: PN-185/65R15"></div>'+
        '<div class="field"><label>Categoria</label><select id="mCat">'+catOptions(editing?material.category:CATEGORIES[0])+'</select></div>'+
      '</div>'+
      '<div class="grid2">'+
        '<div class="field"><label>Almoxarifado</label><select id="mWh">'+whOptions(defaultWhId)+'</select></div>'+
        '<div class="field"><label>Unidade</label><input id="mUnit" value="'+(editing?esc(material.unit):'UND')+'"></div>'+
      '</div>'+
      '<div class="field"><label>Quantidade '+(editing?'atual':'inicial')+'</label><input id="mQty" type="number" min="0" step="1" required value="'+(editing?esc(material.quantity):'0')+'" '+(editing?'disabled':'')+'></div>'+
      (editing?'<div class="helptext">Para alterar a quantidade, use Movimentação → Ajuste (mantém o histórico correto).</div>':'')+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="matCancel">Cancelar</button>'+
        '<button type="submit" class="btn btn-primary" id="matSave">'+(editing?'Salvar':'Cadastrar')+'</button>'+
      '</div>'+
    '</form>';
  openModal(html, function(root){
    root.querySelector('#matCancel').addEventListener('click', closeModal);
    root.querySelector('#matForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = root.querySelector('#matFormError');
      errEl.hidden = true;
      var name = root.querySelector('#mName').value.trim();
      var code = root.querySelector('#mCode').value.trim();
      var cat = root.querySelector('#mCat').value;
      var whId = root.querySelector('#mWh').value;
      var unit = root.querySelector('#mUnit').value.trim() || 'UND';
      var qty = Number(root.querySelector('#mQty').value);
      if(!name || !code || !whId){ errEl.textContent='Preencha nome, código e almoxarifado.'; errEl.hidden=false; return; }
      var btn = root.querySelector('#matSave'); btn.disabled = true;
      var resp = editing
        ? await apiPost('/api/materials/'+material.id, {name:name, code:code, category:cat, warehouseId:whId, unit:unit})
        : await apiPost('/api/materials', {name:name, code:code, category:cat, warehouseId:whId, unit:unit, quantity: isNaN(qty)?0:qty});
      btn.disabled = false;
      if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível salvar.'; errEl.hidden=false; return; }
      toast(editing ? 'Material atualizado.' : 'Material cadastrado.');
      closeModal();
    });
  });
}

/* ================= warehouse add/edit ================= */
function openWarehouseModal(wh){
  var editing = !!wh;
  var html =
    '<h3>'+(editing?'Renomear almoxarifado':'Novo almoxarifado')+'</h3>'+
    '<div id="whFormError" class="form-error" hidden></div>'+
    '<form id="whForm">'+
      '<div class="field"><label>Nome do almoxarifado</label><input id="whName" required value="'+(editing?esc(wh.name):'')+'" placeholder="ex: Almoxarifado Central"></div>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="whCancel">Cancelar</button>'+
        '<button type="submit" class="btn btn-primary">'+(editing?'Salvar':'Adicionar')+'</button>'+
      '</div>'+
    '</form>';
  openModal(html, function(root){
    root.querySelector('#whCancel').addEventListener('click', closeModal);
    root.querySelector('#whForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = root.querySelector('#whFormError'); errEl.hidden=true;
      var name = root.querySelector('#whName').value.trim();
      if(!name){ errEl.textContent='Informe um nome.'; errEl.hidden=false; return; }
      var btn = root.querySelector('button[type="submit"]'); btn.disabled = true;
      var resp = editing
        ? await apiPost('/api/warehouses/'+wh.id, {name:name})
        : await apiPost('/api/warehouses', {name:name});
      btn.disabled = false;
      if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível salvar.'; errEl.hidden=false; return; }
      toast(editing ? 'Almoxarifado renomeado.' : 'Almoxarifado adicionado.');
      closeModal();
    });
  });
}

/* ================= supplier add/edit ================= */
function openSupplierModal(supplier){
  var editing = !!supplier;
  var html =
    '<h3>'+(editing?'Renomear fornecedor':'Novo fornecedor')+'</h3>'+
    '<div id="supFormError" class="form-error" hidden></div>'+
    '<form id="supForm">'+
      '<div class="field"><label>Nome do fornecedor</label><input id="supName" required value="'+(editing?esc(supplier.name):'')+'" placeholder="ex: Renove Pneus"></div>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="supCancel">Cancelar</button>'+
        '<button type="submit" class="btn btn-primary">'+(editing?'Salvar':'Adicionar')+'</button>'+
      '</div>'+
    '</form>';
  openModal(html, function(root){
    root.querySelector('#supCancel').addEventListener('click', closeModal);
    root.querySelector('#supForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = root.querySelector('#supFormError'); errEl.hidden=true;
      var name = root.querySelector('#supName').value.trim();
      if(!name){ errEl.textContent='Informe um nome.'; errEl.hidden=false; return; }
      var btn = root.querySelector('button[type="submit"]'); btn.disabled = true;
      var resp = editing
        ? await apiPost('/api/suppliers/'+supplier.id, {name:name})
        : await apiPost('/api/suppliers', {name:name});
      btn.disabled = false;
      if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível salvar.'; errEl.hidden=false; return; }
      toast(editing ? 'Fornecedor renomeado.' : 'Fornecedor adicionado.');
      closeModal();
    });
  });
}

/* ================= movement modal ================= */
function openMovementModal(type){
  var labels = {
    entrada:{title:'Registrar entrada', personLabel:'Recebido por', qtyLabel:'Quantidade recebida'},
    saida:{title:'Registrar saída', personLabel:'Retirado por (borracheiro)', qtyLabel:'Quantidade retirada'},
    ajuste:{title:'Ajuste de estoque', personLabel:'Responsável pela contagem', qtyLabel:'Nova quantidade (contada)'}
  };
  var L = labels[type];
  var isEntrada = type === 'entrada';
  /* Quando o admin está em "Todos os almoxarifados", materialsInScope() traz os mesmos códigos
     repetidos uma vez por almoxarifado — nesse caso pedimos o almoxarifado ANTES do material,
     pra lista de materiais nunca mostrar duas vezes o mesmo código (o que já causou entradas
     lançadas sem querer no almoxarifado errado). Fora desse caso (admin filtrado num só
     almoxarifado, ou operador — que já é travado em um só) a lista já vem de um único
     almoxarifado, então não tem ambiguidade e o campo Almoxarifado fica só como confirmação. */
  var needsWhPicker = isAdmin() && activeWarehouseId === ALL_WAREHOUSES;
  var lockedWhId = needsWhPicker ? null : (isAdmin() ? activeWarehouseId : (currentUser && currentUser.warehouseId));
  var emptyCheck = needsWhPicker ? materials : materialsInScope();
  if(emptyCheck.length===0){ toast('Cadastre um material antes de registrar movimentação.'); return; }
  var firstWhId = needsWhPicker ? visibleWarehouses()[0].id : lockedWhId;

  var html =
    '<h3>'+L.title+'</h3>'+
    '<div id="movFormError" class="form-error" hidden></div>'+
    '<form id="movForm">'+
      (needsWhPicker ?
        '<div class="field"><label>Almoxarifado</label><select id="movWh" required>'+whOptions(firstWhId)+'</select><div class="helptext">Escolha o almoxarifado antes do material — a lista abaixo mostra só os itens dele.</div></div>'
        :
        '<div class="field"><label>Almoxarifado</label><select id="movWh" disabled></select><div class="helptext">Determinado automaticamente (o do seu almoxarifado).</div></div>'
      )+
      '<div class="field"><label>Material</label><select id="movMaterial" required></select></div>'+
      '<div class="grid2">'+
        '<div class="field"><label>'+L.qtyLabel+'</label><input id="movQty" type="number" min="0" step="1" required></div>'+
        '<div class="field"><label>Data</label><input id="movDate" type="date" value="'+todayStr()+'" required></div>'+
      '</div>'+
      '<div class="grid2">'+
        (isEntrada ?
          '<div class="field"><label>Fornecedor <span style="font-weight:400;color:var(--ink-faint);">(opcional)</span></label><select id="movSupplier"><option value="">— selecione —</option>'+supplierOptions()+'</select></div>'
          :
          '<div class="field"><label>Ativo <span style="font-weight:400;color:var(--ink-faint);">(opcional)</span></label><input id="movAsset" placeholder="ex: 126.0111"></div>'
        )+
        '<div class="field"><label>'+L.personLabel+'</label><input id="movPerson" required placeholder="Nome"></div>'+
      '</div>'+
      '<div class="field"><label>Observação <span style="font-weight:400;color:var(--ink-faint);">(opcional)</span></label><input id="movNote" placeholder="ex: reposição mensal"></div>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="movCancel">Cancelar</button>'+
        '<button type="submit" class="btn btn-primary">Registrar</button>'+
      '</div>'+
    '</form>';
  openModal(html, function(root){
    var matSel = root.querySelector('#movMaterial');
    var whSel = root.querySelector('#movWh');
    function renderMatOptions(whId){
      var list = needsWhPicker ? materials.filter(function(m){ return m.warehouseId === whId; }) : materialsInScope();
      matSel.innerHTML = list.map(function(m){return '<option value="'+m.id+'">'+esc(m.code)+' — '+esc(m.name)+' ('+m.quantity+' '+esc(m.unit)+')</option>';}).join('');
    }
    if(needsWhPicker){
      renderMatOptions(whSel.value);
      whSel.addEventListener('change', function(){ renderMatOptions(whSel.value); });
    } else {
      whSel.innerHTML = whOptions(lockedWhId);
      renderMatOptions(lockedWhId);
    }
    root.querySelector('#movCancel').addEventListener('click', closeModal);
    root.querySelector('#movForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = root.querySelector('#movFormError'); errEl.hidden=true;
      var m = materialById(matSel.value);
      var qtyInput = Number(root.querySelector('#movQty').value);
      var date = root.querySelector('#movDate').value;
      var asset = isEntrada ? '' : root.querySelector('#movAsset').value.trim();
      var supplierId = isEntrada ? root.querySelector('#movSupplier').value : '';
      var person = root.querySelector('#movPerson').value.trim();
      var whId = whSel.value;
      var note = root.querySelector('#movNote').value.trim();
      if(!m || isNaN(qtyInput) || qtyInput<0 || !date || !person){ errEl.textContent='Preencha os campos obrigatórios.'; errEl.hidden=false; return; }
      var btn = root.querySelector('button[type="submit"]'); btn.disabled = true;
      var resp = await apiPost('/api/movements', {
        type:type, materialId:m.id, quantity:qtyInput, date:date, asset:asset,
        supplierId:supplierId, person:person, warehouseId:whId, note:note,
        username: currentUser.username
      });
      btn.disabled = false;
      if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível registrar.'; errEl.hidden=false; return; }
      toast('Movimentação registrada.');
      closeModal();
      setPage('movements');
    });
  });
}

/* ================= users modal ================= */
function openUserModal(){
  var html =
    '<h3>Novo usuário</h3>'+
    '<div id="userFormError" class="form-error" hidden></div>'+
    '<form id="userForm">'+
      '<div class="field"><label>Usuário</label><input id="uUser" required placeholder="ex: joao.silva"></div>'+
      '<div class="field"><label>Senha</label><input id="uPass" type="password" required minlength="4"></div>'+
      '<div class="field"><label>Perfil</label><select id="uRole"><option value="operador">Operador</option><option value="admin">Administrador</option></select></div>'+
      '<div class="field" id="uWhField"><label>Almoxarifado</label><select id="uWh">'+whOptionsAll()+'</select>'+
        '<div class="helptext">O operador só vê e mexe nesse almoxarifado. Administradores têm acesso a todos, sem precisar escolher.</div></div>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="uCancel">Cancelar</button>'+
        '<button type="submit" class="btn btn-primary">Criar usuário</button>'+
      '</div>'+
    '</form>';
  openModal(html, function(root){
    var roleSel = root.querySelector('#uRole');
    var whField = root.querySelector('#uWhField');
    function syncWhField(){ whField.hidden = roleSel.value !== 'operador'; }
    roleSel.addEventListener('change', syncWhField);
    syncWhField();
    root.querySelector('#uCancel').addEventListener('click', closeModal);
    root.querySelector('#userForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = root.querySelector('#userFormError'); errEl.hidden=true;
      var uname = root.querySelector('#uUser').value.trim().toLowerCase();
      var pass = root.querySelector('#uPass').value;
      var role = roleSel.value;
      var whId = root.querySelector('#uWh').value;
      if(!uname || pass.length<4){ errEl.textContent='Usuário obrigatório e senha com ao menos 4 caracteres.'; errEl.hidden=false; return; }
      if(role==='operador' && !whId){ errEl.textContent='Selecione o almoxarifado do operador.'; errEl.hidden=false; return; }
      var btn = root.querySelector('button[type="submit"]'); btn.disabled=true; btn.textContent='Criando…';
      var resp = await apiPost('/api/users', {username:uname, password:pass, role:role, warehouseId: role==='operador'?whId:''});
      btn.disabled=false; btn.textContent='Criar usuário';
      if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível criar o usuário.'; errEl.hidden=false; return; }
      toast('Usuário criado.');
      closeModal();
    });
  });
}
/* ================= trocar almoxarifado de um operador ================= */
function openChangeUserWarehouseModal(username){
  var u = users.find(function(x){return x.username===username;});
  if(!u) return;
  var html =
    '<h3>Trocar almoxarifado — '+esc(username)+'</h3>'+
    '<div id="cwFormError" class="form-error" hidden></div>'+
    '<form id="cwForm">'+
      '<div class="field"><label>Almoxarifado</label><select id="cwWh">'+whOptionsAll(u.warehouseId)+'</select></div>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="cwCancel">Cancelar</button>'+
        '<button type="submit" class="btn btn-primary">Salvar</button>'+
      '</div>'+
    '</form>';
  openModal(html, function(root){
    root.querySelector('#cwCancel').addEventListener('click', closeModal);
    root.querySelector('#cwForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = root.querySelector('#cwFormError'); errEl.hidden=true;
      var whId = root.querySelector('#cwWh').value;
      var btn = root.querySelector('button[type="submit"]'); btn.disabled = true;
      var resp = await apiPost('/api/users/'+encodeURIComponent(username)+'/warehouse', {warehouseId:whId});
      btn.disabled = false;
      if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível trocar o almoxarifado.'; errEl.hidden=false; return; }
      toast('Almoxarifado atualizado.');
      closeModal();
    });
  });
}
function openResetPasswordModal(username){
  var html =
    '<h3>Redefinir senha — '+esc(username)+'</h3>'+
    '<div id="rpFormError" class="form-error" hidden></div>'+
    '<form id="rpForm">'+
      '<div class="field"><label>Nova senha</label><input id="rpPass" type="password" required minlength="4"></div>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="rpCancel">Cancelar</button>'+
        '<button type="submit" class="btn btn-primary">Salvar</button>'+
      '</div>'+
    '</form>';
  openModal(html, function(root){
    root.querySelector('#rpCancel').addEventListener('click', closeModal);
    root.querySelector('#rpForm').addEventListener('submit', async function(e){
      e.preventDefault();
      var errEl = root.querySelector('#rpFormError'); errEl.hidden=true;
      var pass = root.querySelector('#rpPass').value;
      if(pass.length<4){ errEl.textContent='Senha muito curta.'; errEl.hidden=false; return; }
      var btn = root.querySelector('button[type="submit"]'); btn.disabled = true;
      var resp = await apiPost('/api/users/'+encodeURIComponent(username)+'/password', {password:pass});
      btn.disabled = false;
      if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível redefinir a senha.'; errEl.hidden=false; return; }
      toast('Senha redefinida.');
      closeModal();
    });
  });
}

/* ================= exportação de contagem diária em Excel (.xlsx) =================
   Gerador mínimo de .xlsx em JS puro (sem depender de internet nem bibliotecas
   externas): um .xlsx é um .zip com alguns XML dentro. As funções abaixo montam
   esse zip "na mão" (sem compressão, método STORE) e as planilhas em XML OOXML. */
var CRC_TABLE = (function(){
  var t = new Uint32Array(256);
  for(var n=0;n<256;n++){
    var c = n;
    for(var k=0;k<8;k++){ c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes){
  var crc = 0xFFFFFFFF;
  for(var i=0;i<bytes.length;i++){ crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8); }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function strToBytes(str){ return new TextEncoder().encode(str); }

function makeZip(files){
  var localParts = [];
  var centralParts = [];
  var offset = 0;
  var dosTime = 0, dosDate = 0x21; // data fixa (01/01/1980) só para satisfazer o formato

  files.forEach(function(f){
    var nameBytes = strToBytes(f.name);
    var data = f.data;
    var crc = crc32(data);
    var size = data.length;

    var local = new Uint8Array(30 + nameBytes.length);
    var dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    var central = new Uint8Array(46 + nameBytes.length);
    var cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  });

  var centralSize = centralParts.reduce(function(a,p){return a+p.length;},0);
  var centralOffset = offset;

  var end = new Uint8Array(22);
  var edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true);

  var totalLen = offset + centralSize + end.length;
  var out = new Uint8Array(totalLen);
  var pos = 0;
  localParts.forEach(function(p){ out.set(p, pos); pos += p.length; });
  centralParts.forEach(function(p){ out.set(p, pos); pos += p.length; });
  out.set(end, pos);
  return out;
}

function xmlEscape(s){
  return String(s===undefined||s===null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c];
  });
}
function colLetter(idx){
  var s = '', n = idx+1;
  while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); }
  return s;
}
function xlsxCell(colIdx, rowIdx, value, styleIdx){
  var ref = colLetter(colIdx)+rowIdx;
  var sAttr = styleIdx ? ' s="'+styleIdx+'"' : '';
  if(typeof value === 'number' && isFinite(value)){
    return '<c r="'+ref+'"'+sAttr+'><v>'+value+'</v></c>';
  }
  var text = (value===undefined||value===null) ? '' : String(value);
  return '<c r="'+ref+'" t="inlineStr"'+sAttr+'><is><t xml:space="preserve">'+xmlEscape(text)+'</t></is></c>';
}
function buildXlsx(sheetName, header, rows){
  var sheetXmlRows = [];
  var rowIdx = 1;
  sheetXmlRows.push('<row r="'+rowIdx+'">' + header.map(function(h,i){ return xlsxCell(i, rowIdx, h, 1); }).join('') + '</row>');
  rowIdx++;
  rows.forEach(function(r){
    sheetXmlRows.push('<row r="'+rowIdx+'">' + r.map(function(v,i){ return xlsxCell(i, rowIdx, v, 0); }).join('') + '</row>');
    rowIdx++;
  });
  var lastCol = colLetter(header.length-1);
  var dim = 'A1:'+lastCol+(rowIdx-1);

  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'+
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+
    '</Types>';

  var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'+
    '</Relationships>';

  var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
    '<sheets><sheet name="'+xmlEscape(sheetName).slice(0,31)+'" sheetId="1" r:id="rId1"/></sheets>'+
    '</workbook>';

  var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'+
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'+
    '</Relationships>';

  var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'+
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'+
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
    '<cellXfs count="2">'+
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'+
    '</cellXfs>'+
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'+
    '</styleSheet>';

  var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<dimension ref="'+dim+'"/>'+
    '<sheetData>'+sheetXmlRows.join('')+'</sheetData>'+
    '</worksheet>';

  var files = [
    {name:'[Content_Types].xml', data: strToBytes(contentTypes)},
    {name:'_rels/.rels', data: strToBytes(rootRels)},
    {name:'xl/workbook.xml', data: strToBytes(workbook)},
    {name:'xl/_rels/workbook.xml.rels', data: strToBytes(workbookRels)},
    {name:'xl/styles.xml', data: strToBytes(styles)},
    {name:'xl/worksheets/sheet1.xml', data: strToBytes(sheet)}
  ];
  return makeZip(files);
}

function downloadBytes(bytes, filename, mime){
  try{
    var blob = new Blob([bytes], {type: mime});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    return true;
  }catch(err){ console.error(err); return false; }
}

function exportCountExcel(date){
  date = date || todayStr();
  var counts = (store.dailyCounts && store.dailyCounts[date]) ? store.dailyCounts[date] : {};
  var rows = materialsInScope().slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).map(function(m){
    var raw = counts[m.id];
    var has = hasCountValue(raw);
    var sysQty = Number(m.quantity||0);
    var countedQty = has ? Number(raw) : '(não contado)';
    var diff = has ? (Number(raw) - sysQty) : '—';
    return [m.code, m.name, m.warehouseName, sysQty, countedQty, diff];
  });
  var header = ['Código','Material','Almoxarifado','Qtd. sistema','Qtd. contada','Diferença'];
  try{
    var bytes = buildXlsx('Contagem '+date, header, rows);
    var ok = downloadBytes(bytes, 'contagem-pneus-'+date+'.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast(ok ? 'Planilha da contagem baixada.' : 'Não foi possível gerar o Excel neste ambiente.');
  }catch(err){
    console.error(err);
    toast('Não foi possível gerar o Excel neste ambiente.');
  }
}

/* ================= event wiring ================= */
function wireStaticEvents(){
  document.querySelectorAll('.nav-item').forEach(function(n){
    n.addEventListener('click', function(){ setPage(n.dataset.page); });
  });
  qs('hamburger').addEventListener('click', function(){
    qs('sidebar').classList.add('open');
    qs('sidebarScrim').classList.add('show');
  });
  qs('sidebarScrim').addEventListener('click', function(){
    qs('sidebar').classList.remove('open');
    qs('sidebarScrim').classList.remove('show');
  });
  qs('logoutBtn').addEventListener('click', doLogout);

  qs('addMaterialBtn').addEventListener('click', function(){ openMaterialModal(null); });
  qs('addWarehouseBtn').addEventListener('click', function(){ openWarehouseModal(null); });
  qs('addSupplierBtn').addEventListener('click', function(){ openSupplierModal(null); });
  qs('addUserBtn').addEventListener('click', openUserModal);
  qs('exportBackupBtn').addEventListener('click', exportBackup);
  qs('importBackupBtn').addEventListener('click', function(){ qs('importBackupInput').click(); });
  qs('importBackupInput').addEventListener('change', function(e){
    var file = e.target.files && e.target.files[0];
    if(file) importBackupFile(file);
    e.target.value = '';
  });
  qs('btnEntrada').addEventListener('click', function(){ openMovementModal('entrada'); });
  qs('btnSaida').addEventListener('click', function(){ openMovementModal('saida'); });
  qs('btnAjuste').addEventListener('click', function(){ openMovementModal('ajuste'); });

  qs('dismissSeedBanner').addEventListener('click', function(){
    seedBannerDismissed = true;
    qs('seedBanner').hidden = true;
    try{ localStorage.setItem('tireapp_seed_dismissed','1'); }catch(e){}
  });

  ['matSearch','matCatFilter','matWhFilter'].forEach(function(id){
    qs(id).addEventListener('input', renderMaterials);
    qs(id).addEventListener('change', renderMaterials);
  });
  ['histSearch','histTypeFilter','histDateFrom','histDateTo'].forEach(function(id){
    qs(id).addEventListener('input', renderHistory);
    qs(id).addEventListener('change', renderHistory);
  });
  qs('exportHistoryBtn').addEventListener('click', exportHistoryExcel);

  qs('countSearch').addEventListener('input', renderCount);
  qs('exportCountBtn').addEventListener('click', function(){ exportCountExcel(todayStr()); });
  qs('clearCountBtn').addEventListener('click', function(){
    var today = todayStr();
    var counts = todayCountMap();
    var scopedIds = {}; materialsInScope().forEach(function(m){ scopedIds[m.id]=true; });
    var scopedCount = Object.keys(counts).filter(function(k){ return scopedIds[k]; }).length;
    if(scopedCount===0){ toast('A contagem de hoje já está vazia.'); return; }
    var whId = activeWarehouseId;
    var scopeLabel = (isAdmin() && whId===ALL_WAREHOUSES) ? 'de TODOS os almoxarifados' : ('do almoxarifado '+esc(warehouseName(whId)));
    var html =
      '<h3>Limpar contagem de hoje</h3>'+
      '<p style="color:var(--ink-soft);font-size:13.5px;">Isso apaga os valores digitados na contagem '+scopeLabel+' de <b>'+fmtDate(today)+'</b>. Essa ação não pode ser desfeita.</p>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="ccCancel">Cancelar</button>'+
        '<button type="button" class="btn btn-danger" id="ccConfirm">Limpar</button>'+
      '</div>';
    openModal(html, function(root){
      root.querySelector('#ccCancel').addEventListener('click', closeModal);
      root.querySelector('#ccConfirm').addEventListener('click', async function(){
        var btn = root.querySelector('#ccConfirm'); btn.disabled = true;
        var resp = await apiPost('/api/counts/'+today+'/clear', {warehouseId: whId});
        btn.disabled = false;
        if(!resp.ok){ toast(resp.error || 'Não foi possível limpar a contagem.'); return; }
        toast('Contagem de hoje limpa.');
        closeModal();
      });
    });
  });
  qs('countBody').addEventListener('input', function(e){
    var mid = e.target.getAttribute && e.target.getAttribute('data-count-material');
    if(!mid) return;
    var val = e.target.value;
    // feedback imediato na própria linha, sem esperar o servidor nem redesenhar a tabela toda
    var m = materialById(mid);
    var row = e.target.closest('tr');
    var diffCell = row && row.querySelector('[data-diff-cell]');
    if(diffCell && m){ diffCell.innerHTML = diffPillHtml(val, m.quantity); }

    clearTimeout(countInputTimers[mid]);
    countInputTimers[mid] = setTimeout(async function(){
      var today = todayStr();
      var resp = await apiPost('/api/counts', {date:today, materialId:mid, value: val===''?null:Number(val)});
      if(!resp.ok){ toast(resp.error || 'Não foi possível salvar a contagem.'); }
    }, 350);
  });

  qs('content').addEventListener('click', function(e){
    var editId = e.target.getAttribute && e.target.getAttribute('data-edit-material');
    if(editId){ openMaterialModal(materialById(editId)); return; }
    var whId = e.target.getAttribute && e.target.getAttribute('data-edit-warehouse');
    if(whId){ openWarehouseModal(warehouses.find(function(w){return w.id===whId;})); return; }
    var supId = e.target.getAttribute && e.target.getAttribute('data-edit-supplier');
    if(supId){ openSupplierModal(suppliers.find(function(s){return s.id===supId;})); return; }
    var exportDate = e.target.getAttribute && e.target.getAttribute('data-export-count-date');
    if(exportDate){ exportCountExcel(exportDate); return; }
    var resetU = e.target.getAttribute && e.target.getAttribute('data-reset-user');
    if(resetU){ openResetPasswordModal(resetU); return; }
    var delU = e.target.getAttribute && e.target.getAttribute('data-del-user');
    if(delU){ confirmDeleteUser(delU); return; }
    var chWhUser = e.target.getAttribute && e.target.getAttribute('data-change-wh-user');
    if(chWhUser){ openChangeUserWarehouseModal(chWhUser); return; }
  });

  qs('whSwitcher').addEventListener('change', function(){
    activeWarehouseId = this.value;
    renderAll();
  });
}

function confirmDeleteUser(username){
  var admins = users.filter(function(u){return u.role==='admin';});
  var target = users.find(function(u){return u.username===username;});
  if(target && target.role==='admin' && admins.length<=1){ toast('Não é possível remover o único administrador.'); return; }
  var html =
    '<h3>Remover usuário</h3>'+
    '<p style="color:var(--ink-soft);font-size:13.5px;">Remover <b>'+esc(username)+'</b>? Essa ação não pode ser desfeita.</p>'+
    '<div class="modal-actions">'+
      '<button type="button" class="btn btn-secondary" id="delCancel">Cancelar</button>'+
      '<button type="button" class="btn btn-danger" id="delConfirm">Remover</button>'+
    '</div>';
  openModal(html, function(root){
    root.querySelector('#delCancel').addEventListener('click', closeModal);
    root.querySelector('#delConfirm').addEventListener('click', async function(){
      var btn = root.querySelector('#delConfirm'); btn.disabled = true;
      var resp = await apiPost('/api/users/'+encodeURIComponent(username)+'/delete', {});
      btn.disabled = false;
      if(!resp.ok){ toast(resp.error || 'Não foi possível remover o usuário.'); return; }
      toast('Usuário removido.');
      closeModal();
    });
  });
}

/* ================= backup: export / import ================= */
function slugify(s){
  var v = String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-+|-+$)/g,'');
  return v || 'armazem';
}
/* Ajusta os textos e mostra/esconde o painel de "Importar backup" conforme o perfil: o
   operador só pode exportar um arquivo com os dados do PRÓPRIO almoxarifado (registro/arquivo
   pessoal); importar é uma ação administrativa (substitui os dados de todo o sistema) e
   continua disponível só para o admin. */
function renderBackupPage(){
  var desc = qs('exportBackupDesc');
  if(!desc || !currentUser) return;
  var impPanel = qs('importBackupPanel');
  if(isAdmin()){
    desc.textContent = 'Os dados ficam salvos no servidor (compartilhados entre todos os dispositivos da rede). Exporte um arquivo .json com tudo (materiais, movimentações, almoxarifados, fornecedores e usuários) para guardar como backup, ou levar para outro servidor.';
    if(impPanel) impPanel.hidden = false;
  } else {
    desc.textContent = 'Exporte um arquivo .json com os dados do seu almoxarifado ('+warehouseName(currentUser.warehouseId)+'): materiais, movimentações e contagens — útil como registro/arquivo pessoal. A importação de backup mexe nos dados de todo o sistema, por isso fica disponível só para o administrador.';
    if(impPanel) impPanel.hidden = true;
  }
}
async function exportBackup(){
  var payload, filename;
  if(isAdmin()){
    // Os dados que chegam por tempo real (SSE) nunca trazem o hash da senha de ninguém — por
    // segurança, isso não fica trafegando com todo mundo conectado. Só essa rota (que exige
    // login de admin) devolve o backup completo de verdade, pra continuar dando pra restaurar
    // (com login funcionando) depois.
    var fullResp = await fetch('/api/backup/export');
    var full = await fullResp.json();
    if(!full || full.ok === false){
      toast((full && full.error) || 'Não foi possível gerar o backup.');
      return;
    }
    payload = JSON.stringify(full, null, 2);
    filename = 'estoque-pneus-backup-' + todayStr() + '.json';
  } else {
    var whId = currentUser.warehouseId;
    var wh = warehouses.find(function(w){ return w.id===whId; });
    var scopedMats = materials.filter(function(m){ return m.warehouseId===whId; });
    var matIds = {}; scopedMats.forEach(function(m){ matIds[m.id]=true; });
    var scopedMovs = movements.filter(function(m){ return m.warehouseId===whId; });
    var scopedCounts = {};
    Object.keys(store.dailyCounts||{}).forEach(function(date){
      var dayCounts = store.dailyCounts[date]||{};
      var filtered = {};
      Object.keys(dayCounts).forEach(function(mid){ if(matIds[mid]) filtered[mid]=dayCounts[mid]; });
      if(Object.keys(filtered).length) scopedCounts[date]=filtered;
    });
    var data = {
      scope: 'armazem', warehouseId: whId, warehouseName: wh?wh.name:'',
      exportedAt: new Date().toISOString(), exportedBy: currentUser.username,
      warehouses: wh?[wh]:[], suppliers: suppliers, materials: scopedMats, movements: scopedMovs, dailyCounts: scopedCounts
    };
    payload = JSON.stringify(data, null, 2);
    filename = 'backup-' + slugify(wh?wh.name:'armazem') + '-' + todayStr() + '.json';
  }
  try{
    if(window.claude && typeof window.claude.use === 'function'){
      var downloads = await window.claude.use('downloads');
      if(downloads){
        await downloads.save({ filename: filename, data: payload });
        toast('Backup salvo.');
        return;
      }
    }
  }catch(err){
    if(err && err.code === 'declined'){ return; } // usuário cancelou o diálogo, não é erro
    console.warn('downloads capability indisponível, usando download direto do navegador', err);
  }
  var ok = downloadBytes(strToBytes(payload), filename, 'application/json');
  toast(ok ? 'Backup baixado.' : 'Não foi possível gerar o backup neste ambiente.');
}

function importBackupFile(file){
  var reader = new FileReader();
  reader.onload = function(){
    var parsed;
    try{ parsed = JSON.parse(reader.result); }
    catch(e){ toast('Arquivo inválido: não é um JSON de backup reconhecível.'); return; }
    if(!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.warehouses) || !Array.isArray(parsed.materials) || !Array.isArray(parsed.movements)){
      toast('Arquivo inválido: não parece um backup deste app.');
      return;
    }
    var html =
      '<h3>Importar backup</h3>'+
      '<p style="color:var(--ink-soft);font-size:13.5px;">Este arquivo tem <b>'+parsed.materials.length+'</b> material(is), '+
      '<b>'+parsed.movements.length+'</b> movimentação(ões), <b>'+parsed.warehouses.length+'</b> almoxarifado(s) e '+
      '<b>'+parsed.users.length+'</b> usuário(s).<br><br>Importar vai <b>substituir todos os dados atuais do servidor</b>, para todos os dispositivos conectados na rede. Essa ação não pode ser desfeita.</p>'+
      '<div id="impFormError" class="form-error" hidden></div>'+
      '<div class="modal-actions">'+
        '<button type="button" class="btn btn-secondary" id="impCancel">Cancelar</button>'+
        '<button type="button" class="btn btn-danger" id="impConfirm">Substituir dados</button>'+
      '</div>';
    openModal(html, function(root){
      root.querySelector('#impCancel').addEventListener('click', closeModal);
      root.querySelector('#impConfirm').addEventListener('click', async function(){
        var errEl = root.querySelector('#impFormError');
        var btn = root.querySelector('#impConfirm'); btn.disabled = true;
        var resp = await apiPost('/api/backup/import', parsed);
        btn.disabled = false;
        if(!resp.ok){ errEl.textContent = resp.error || 'Não foi possível importar o backup.'; errEl.hidden = false; return; }
        toast('Backup importado com sucesso.');
        closeModal();
      });
    });
  };
  reader.onerror = function(){ toast('Não foi possível ler o arquivo.'); };
  reader.readAsText(file);
}

/* ================= auth ================= */
function showLoginError(msg){
  var el = qs('loginError');
  el.textContent = msg;
  el.hidden = false;
}
async function doLogin(e){
  e.preventDefault();
  qs('loginError').hidden = true;
  var uname = qs('loginUser').value.trim().toLowerCase();
  var pass = qs('loginPass').value;
  var btn = qs('loginBtn');
  btn.disabled = true; btn.textContent = 'Entrando…';
  var resp = await apiPost('/api/login', {username: uname, password: pass});
  if(!resp.ok){
    showLoginError(resp.error || 'Usuário ou senha inválidos.');
    btn.disabled=false; btn.textContent='Entrar';
    return;
  }
  currentUser = resp.user;
  btn.disabled=false; btn.textContent='Entrar';
  // O login gravou um cookie de sessão no navegador; a conexão em tempo real que já estava
  // aberta (sem login) não usa esse cookie retroativamente, então reabrimos pra virar uma
  // conexão autenticada e passar a receber os dados de verdade.
  connectRealtime();
  enterApp();
}
function doLogout(msg){
  var wasLoggedIn = !!currentUser;
  currentUser = null;
  activeWarehouseId = null;
  qs('appScreen').hidden = true;
  qs('loginScreen').hidden = false;
  qs('loginPass').value = '';
  if(typeof msg === 'string' && msg){ showLoginError(msg); } else { qs('loginError').hidden = true; }
  if(wasLoggedIn){
    apiPost('/api/logout', {}).catch(function(){});
    connectRealtime();
  }
}
function enterApp(){
  qs('loginScreen').hidden = true;
  qs('appScreen').hidden = false;
  qs('whoName').textContent = currentUser.username;
  qs('whoRole').textContent = currentUser.role;
  qs('whoAvatar').textContent = currentUser.username.slice(0,2).toUpperCase();
  qs('navUsersItem').hidden = !isAdmin();
  qs('navWarehousesItem').hidden = !isAdmin();
  qs('navBackupItem').hidden = false; // todo mundo pode acessar Backup agora (operador só exporta)
  activeWarehouseId = isAdmin() ? (activeWarehouseId || ALL_WAREHOUSES) : currentUser.warehouseId;
  renderAll();
  setPage('dashboard');
}

/* ================= init ================= */
/* Se o navegador ainda tem um cookie de sessão válido (login de até 30 dias atrás), entra direto
   no app sem pedir login de novo — útil principalmente quando o sistema está hospedado na
   internet, onde a aba recarrega com mais frequência (celular, Wi‑Fi instável) do que na rede
   local. Se não tiver sessão válida (ou o servidor tiver reiniciado, o que apaga as sessões da
   memória), cai na tela de login normalmente. */
async function tryRestoreSession(){
  try{
    var res = await fetch('/api/session', {method:'GET'});
    var data = await res.json();
    if(data && data.ok && data.user){
      currentUser = data.user;
      connectRealtime();
      enterApp();
    }
  }catch(e){ /* sem sessão — segue pra tela de login */ }
}
function init(){
  wireStaticEvents();
  qs('loginForm').addEventListener('submit', doLogin);
  connectRealtime();
  tryRestoreSession();
}
if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }

})();
