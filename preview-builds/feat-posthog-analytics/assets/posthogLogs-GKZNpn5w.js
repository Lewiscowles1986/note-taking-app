import{D as r,r as d,j as i,H as s,I as u,J as f,K as n}from"./index-CV9fVAsQ.js";/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=[["path",{d:"M12 17V3",key:"1cwfxf"}],["path",{d:"m6 11 6 6 6-6",key:"12ii2o"}],["path",{d:"M19 21H5",key:"150jfl"}]],L=r("arrow-down-to-line",m);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const p=[["path",{d:"m18 9-6-6-6 6",key:"kcunyi"}],["path",{d:"M12 3v14",key:"7cf3v8"}],["path",{d:"M5 21h14",key:"11awu3"}]],j=r("arrow-up-from-line",p);/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=[["path",{d:"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",key:"p7xjir"}]],N=r("cloud",b),y=d.forwardRef(({className:e,type:o,...a},t)=>i.jsx("input",{type:o,className:s("flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",e),ref:t,...a}));y.displayName="Input";var g=Object.defineProperty,w=(e,o)=>g(e,"name",{value:o,configurable:!0}),x=d.forwardRef(w(function(o,a){return i.jsx(u.label,{...o,ref:a,onMouseDown:t=>{var l;t.target.closest("button, input, select, textarea")||((l=o.onMouseDown)==null||l.call(o,t),!t.defaultPrevented&&t.detail>1&&t.preventDefault())}})},"Label")),c=x;const _=f("text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"),h=d.forwardRef(({className:e,...o},a)=>i.jsx(c,{ref:a,className:s(_(),e),...o}));h.displayName=c.displayName;function M(e){const o={event:"sync.round.completed",outcome:e.ok?"success":"partial_failure",pushed_count:e.pushed,pulled_count:e.pulled,deleted_local_count:e.deletedLocal,deleted_remote_count:e.deletedRemote,error_count:e.errors.length};e.ok?n.info("sync round completed",o):n.warn("sync round completed with problems",o)}function R(){n.error("sync round failed",{event:"sync.round.failed"})}export{j as A,N as C,y as I,h as L,L as a,R as b,M as l};
