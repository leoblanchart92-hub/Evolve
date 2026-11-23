import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { PRODUCT } from '../config.js';
import { ui, volumeGlyph } from '../shell/ui-state.js';
import { checkUpdates, installUpdate } from '../core/platform.js';

const SECTIONS = [
  ['general','Général','gear-six'],
  ['personalization','Personnalisation','sparkle'],
  ['desktop','Bureau','desktop'],
  ['quick','Paramètres rapides','gear-six'],
  ['updates','Mise à jour Evolve','arrow-clockwise'],
  ['about','À propos','info'],
];
function toggle(id,label,description='') {
  const btn=h('button',{class:'settings-switch',type:'button',role:'switch','aria-label':label,'aria-checked':String(Boolean(ui.get(id))),dataset:{setting:id}},h('span',{class:'settings-switch__knob'}));
  btn.addEventListener('click',()=>ui.toggle(id));
  ui.subscribe(id,v=>{btn.setAttribute('aria-checked',String(Boolean(v)));btn.classList.toggle('is-on',Boolean(v));});
  return h('article',{class:'settings-row'},h('div',{class:'settings-row__text'},h('strong',{text:label}),description?h('p',{text:description}):null),btn);
}
function slider(id,label,min,glyph) {
  const input=h('input',{class:'settings-slider',type:'range',min:String(min),max:'100',step:'1','aria-label':label});
  const value=h('span',{class:'settings-slider__value'});
  const sync=v=>{input.value=String(v);input.style.setProperty('--pct',((v-min)/(100-min)*100)+'%');value.textContent=v+' %';};
  ui.subscribe(id,sync);
  input.addEventListener('input',()=>{ui.set(id,Number(input.value));if(id==='volume'&&ui.get('muted'))ui.set('muted',false);});
  return h('article',{class:'settings-row settings-row--slider'},h('div',{class:'settings-row__text'},h('strong',{text:label})),h('div',{class:'settings-slider-wrap'},icon(glyph,'fill'),input,value));
}
function heading(title,desc){return h('header',{class:'settings-heading'},h('h2',{text:title}),h('p',{text:desc}));}
function card(title,...children){return h('section',{class:'settings-card'},h('h3',{text:title}),...children);}
function buildPage(id){
 if(id==='general')return [heading('Général','Les réglages essentiels de ton environnement Evolve.'),card('Comportement',toggle('doNotDisturb','Ne pas déranger','Désactive visuellement les interruptions.'),toggle('energySaver',"Économie d’énergie",'Mode visuel uniquement.'))];
 if(id==='personalization')return [heading('Personnalisation','Adapte l’apparence et l’ambiance du bureau.'),card('Éclairage',toggle('nightLight','Éclairage nocturne','Applique une teinte chaude à l’interface.'),slider('brightness','Luminosité de l’interface',20,'sun'))];
 if(id==='desktop')return [heading('Bureau','Choisis les éléments visibles sur le bureau.'),card('Visibilité',toggle('widgetsVisible','Afficher les widgets','Horloge et widgets de démonstration.'),toggle('desktopIconsVisible','Afficher les icônes du bureau','Masquer ou afficher les raccourcis.'))];
 if(id==='quick')return [heading('Paramètres rapides','Contrôle les états simulés de l’interface.'),card('Connectivité (simulation)',toggle('wifi','Wi-Fi','Ne pilote pas la connexion réseau Windows.'),toggle('bluetooth','Bluetooth','Ne modifie pas Bluetooth Windows.'),toggle('airplane','Mode avion','Indicateur uniquement dans Evolve.')),card('Son',toggle('muted','Couper le son (indicateur)','Ne pilote pas le volume Windows.'),slider('volume','Volume affiché',0,volumeGlyph(ui.get('volume'),ui.get('muted'))))];
 if(id==='updates')return [heading('Mise à jour Evolve','Vérifie les versions publiées sur GitHub.'),card('Mises à jour',h('p',{class:'settings-about__note',text:'Version installée : '+PRODUCT.version}),h('button',{class:'settings-update-button',type:'button',text:'Rechercher des mises à jour',dataset:{updateCheck:'true'}}),h('p',{class:'settings-update-status',dataset:{updateStatus:'true',text:'Appuie sur le bouton pour vérifier.'}}))];
 if(id==='about')return [heading('À propos d’Evolve','Informations sur cette version.'),card('Evolve',h('div',{class:'settings-about'},h('span',{class:'settings-about__logo'},icon('planet','fill')),h('div',{},h('strong',{text:PRODUCT.name}),h('p',{text:'Version '+PRODUCT.version+' · '+PRODUCT.stage}))),h('p',{class:'settings-about__note',text:'Evolve est un aperçu d’environnement de bureau. Il ne remplace pas Windows et ne modifie pas ses paramètres système.'}))];
 return [];
}
export function mountSettings(win){
 const nav=h('aside',{class:'settings-sidebar','aria-label':'Sections des paramètres'});
 const content=h('main',{class:'settings-content',tabindex:'-1'});
 const root=h('div',{class:'settings-app'},nav,content);win.body.append(root);
 function render(id){content.replaceChildren(...buildPage(id));nav.querySelectorAll('[data-page]').forEach(b=>{const active=b.dataset.page===id;b.classList.toggle('is-current',active);b.setAttribute('aria-current',active?'page':'false');});}
 SECTIONS.forEach(([id,label,glyph])=>{const b=h('button',{class:'settings-nav',type:'button',dataset:{page:id}},icon(glyph,'fill'),h('span',{text:label}));b.addEventListener('click',()=>render(id));nav.append(b);});
 render('general');
 content.addEventListener('click',async event=>{const button=event.target.closest('[data-update-check]');if(button){const status=content.querySelector('[data-update-status]');if(!status)return;button.disabled=true;status.textContent='Recherche en cours…';content.querySelector('[data-update-install]')?.remove();try{const result=await checkUpdates();if(!result.updateAvailable)status.textContent='Evolve est à jour (version '+result.currentVersion+').';else{status.textContent='Nouvelle version : '+result.latestVersion+'\\n'+(result.notes||'');if(result.setupUrl&&result.setupName){const install=h('button',{class:'settings-update-button',type:'button',text:'Télécharger et installer '+result.latestVersion,dataset:{updateInstall:'true'}});install.addEventListener('click',async()=>{install.disabled=true;status.textContent='Téléchargement de la mise à jour…';try{await installUpdate(result.setupUrl,result.setupName);status.textContent='Installateur lancé. Evolve va se fermer pour procéder à la mise à jour.';}catch(e){status.textContent=e?.message||'Installation impossible.';}finally{install.disabled=false;}});status.after(install);}}}catch(error){status.textContent=error?.message||'Vérification impossible. Vérifie ta connexion.';}finally{button.disabled=false;}return;}});
 return {destroy(){root.remove();}};
}
