/**
 * Decides, before the first paint, whether this start shows the splash
 * (Effects → Opening the app): once per start of the app or tab, never on a
 * TV, never with motion reduced, never when the account switched it off. The
 * account's choices are read from this device's copy of the arrangement.
 * The TV checks mirror lib/hooks/useIsTV.
 */
export const SPLASH_SCRIPT = `try{var d=document.documentElement,s=sessionStorage;if(!s.getItem('slicksync-splash')){s.setItem('slicksync-splash','1');var a={};try{a=JSON.parse(localStorage.getItem('slicksync-arrange')||'{}')||{}}catch(e){}var m=a.motion,tv=window.__SLICKSYNC_TV__===true||/[?&]tv=1/.test(location.search)||s.getItem('slicksync-tv-mode')==='1'||/\\bAFT[A-Z]|Android TV|\\bBRAVIA\\b|GoogleTV/i.test(navigator.userAgent),still=m==='reduced'||(m!=='full'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);if(!tv&&!still&&!(a.effects&&a.effects.splash===false))d.setAttribute('data-splash','')}}catch(e){}`;
