/* Existing red focus -> the approved rounded red glow. No input, storage, focus
   or application event is changed. Blue focus and permanent error borders stay native. */
(async function(){
  const key=Symbol.for('izone.red-focus-glow.v1');
  const previous=window[key],root=document.documentElement;
  if(previous?.root===root&&previous.stylesheet?.isConnected&&(previous.loading||previous.ring?.isConnected))return;
  previous?.dispose?.();
  const bootstrap=document.currentScript;
  const source=bootstrap?.src||(bootstrap?.dataset.izRedFocusSource?new URL(bootstrap.dataset.izRedFocusSource,location.href).href:null);if(!source)return;
  const state={root,loading:true};window[key]=state;
  const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';
  if(bootstrap?.nonce)stylesheet.nonce=bootstrap.nonce;
  state.stylesheet=stylesheet;
  stylesheet.href=new URL('red-focus-glow.css?v=20261102-r1',source).href;
  try{await new Promise((resolve,reject)=>{stylesheet.onload=resolve;stylesheet.onerror=reject;document.head.append(stylesheet);});}catch{if(window[key]===state)delete window[key];return;}
  if(window[key]!==state||root!==document.documentElement)return;
  if(!document.body)await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
  const ring=document.createElement('div');ring.className='iz-red-focus-glow';ring.hidden=true;ring.setAttribute('aria-hidden','true');document.body.append(ring);
  state.ring=ring;state.loading=false;
  const topLayer=typeof ring.showPopover==='function';if(topLayer)ring.setAttribute('popover','manual');
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const marked=new Set();let active=null,target=null,pending=false,recheck=true,inputMode='',disposed=false;
  const forced=matchMedia('(forced-colors: active)');
  function red(color){
    if(!color||color==='transparent')return false;
    context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);
    const [r,g,b,a]=context.getImageData(0,0,1,1).data;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
    if(a<8||max<100||delta<60||max!==r)return false;
    const hue=((g-b)/delta*60+360)%360;
    return hue<=15||hue>=340;
  }
  function redOutline(node){const s=getComputedStyle(node);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0&&red(s.outlineColor);}
  function redShadow(node){
    const s=getComputedStyle(node);if(s.boxShadow==='none')return false;
    const colors=s.boxShadow.match(/(?:rgba?|oklch|oklab|color|hsl)a?\([^)]*\)/g)||[];
    return colors.some(red);
  }
  function visible(node){const r=node.getBoundingClientRect();return r.width>=4&&r.height>=4&&r.right>0&&r.bottom>0;}
  function restore(){for(const node of marked)node.removeAttribute('data-iz-red-focus-indicator');marked.clear();target=null;if(topLayer&&ring.matches(':popover-open'))ring.hidePopover();}
  function measure(){
    pending=false;
    if(disposed)return;
    try{
      if(!document.body)return;
      if(!stylesheet.isConnected){restore();ring.hidden=true;document.head.append(stylesheet);return;}
      if(!stylesheet.sheet){restore();ring.hidden=true;return;}
      if(!ring.isConnected){ring.hidden=true;document.body.append(ring);recheck=true;}
      const next=document.activeElement;
      if(next!==active||recheck){
        restore();active=next;recheck=false;
        if(!active||active===document.body||active===document.documentElement||!active.isConnected||forced.matches||(!topLayer&&active.closest('dialog[open]'))){ring.hidden=true;return;}
        const candidates=[];
        if(visible(active)&&(redOutline(active)||redShadow(active)))candidates.push(active);
        // Native hidden checkboxes may put their focus frame on the adjacent glyph.
        const proxy=active.matches('input')?active.nextElementSibling:null;
        if(proxy&&visible(proxy)&&redOutline(proxy))candidates.push(proxy);
        for(let parent=active.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
          if(visible(parent)&&redOutline(parent))candidates.push(parent);
        }
        target=candidates.at(-1)||null;
        for(const node of candidates){node.setAttribute('data-iz-red-focus-indicator','');marked.add(node);}
      }
      if(!target||!target.isConnected||forced.matches){ring.hidden=true;return;}
      const rect=target.getBoundingClientRect();
      if(rect.width<4||rect.height<4){ring.hidden=true;return;}
      for(const [name,value]of Object.entries({left:rect.left,top:rect.top,width:rect.width,height:rect.height})){const css=value+'px';if(ring.style[name]!==css)ring.style[name]=css;}
      ring.hidden=false;
      if(topLayer&&!ring.matches(':popover-open'))ring.showPopover();
    }catch{restore();ring.hidden=true;}
  }
  function schedule(check=false){if(check)recheck=true;if(!pending){pending=true;requestAnimationFrame(measure);}}
  const listeners=[];
  function on(owner,event,listener,options){if(!owner)return;owner.addEventListener(event,listener,options);listeners.push(()=>owner.removeEventListener(event,listener,options));}
  on(document,'focusin',()=>schedule(true),true);
  on(document,'focusout',()=>schedule(true),true);
  on(document,'scroll',()=>schedule(),true);
  on(document,'pointerdown',()=>{if(inputMode!=='pointer'){inputMode='pointer';schedule(true);}},{capture:true,passive:true});
  on(document,'keydown',()=>{if(inputMode!=='keyboard'){inputMode='keyboard';schedule(true);}},{capture:true,passive:true});
  on(window,'resize',()=>schedule());
  on(window.visualViewport,'resize',()=>schedule());
  on(window.visualViewport,'scroll',()=>schedule());
  on(document,'load',event=>{if(event.target instanceof HTMLLinkElement)schedule(true);},true);
  on(forced,'change',()=>schedule(true));
  const resize=new ResizeObserver(()=>schedule());resize.observe(document.body);
  const observer=new MutationObserver(records=>{
    const relevant=records.filter(r=>r.target!==ring&&!ring.contains(r.target));
    if(relevant.length)schedule(relevant.some(r=>r.target===active||(r.type==='attributes'&&r.target.contains(active))||r.target.closest?.('head')));
  });
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden','disabled','data-izone-theme','data-izone-design','data-kind']});
  state.dispose=()=>{disposed=true;restore();ring.remove();stylesheet.remove();observer.disconnect();resize.disconnect();listeners.forEach(remove=>remove());};
  document.fonts?.ready.then(()=>schedule());
  schedule(true);
})();
