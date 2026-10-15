import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('games UI: library, match length, moves, locked picks, reveals and daily completion', async () => {
 const dom = new JSDOM('<div id="root"></div>', {url:'http://localhost'});
 for(const key of ['window','document','HTMLElement','Event','MouseEvent']) globalThis[key]=dom.window[key];
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {default:React,act}=await import('react');
 const {createRoot}=await import('react-dom/client');
 const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false}});
 const root=createRoot(document.getElementById('root'));
 try {
  const {GamesView}=await server.ssrLoadModule('/src/components/games/GamesView.tsx');
  const calls=[];
  const games={data:{matches:[]},error:null,busy:false,match:undefined,select:id=>calls.push(id),start:(...args)=>calls.push(args),play:(...args)=>calls.push(args),refresh:()=>{}};
  const render=()=>act(async()=>root.render(React.createElement(GamesView,{games,userId:'a',partnerName:'Bob'})));
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  await render();
  assert(document.body.textContent.includes('Tic Tac Toe'));
  await act(async()=>button('Best of 5').click());
  await act(async()=>[...document.querySelectorAll('article button')].at(-1).click());
  assert.deepEqual(calls.pop(),['rock-paper-scissors',false,5]);
  games.match={id:'m',game:'tic-tac-toe',player_x:'a',board:Array(9).fill(''),turn_id:'a',round:1,finished:false};
  await render();
  assert.equal(document.querySelectorAll('.ttt-board button').length,9);
  await act(async()=>document.querySelector('.ttt-board button').click());
  assert.equal(calls.pop()[1],'0');
  games.match.turn_id='b'; await render();
  assert([...document.querySelectorAll('.ttt-board button')].every(b=>b.disabled));
  games.match={...games.match,game:'rock-paper-scissors',best_of:5,rounds:[],my_pick:'rock',score_x:0,score_o:0};
  await render();
  assert(document.body.textContent.includes('Your rock is locked'));
  assert([...document.querySelectorAll('.rps-picks button')].every(b=>b.disabled));
  games.match={...games.match,my_pick:null,rounds:[{round:1,x:'rock',o:'scissors',winner:'a'}]};
  await render();
  assert(document.body.textContent.includes('You: rock · Bob: scissors'));
  games.match={...games.match,finished:true,winner_id:'a',daily_date:'2026-10-15'};
  await render();
  assert(document.body.textContent.includes('You won!'));
  assert.equal(button('Play again'),undefined);
  assert(document.body.textContent.includes('midnight UTC'));
 } finally {await act(async()=>root.unmount());await server.close();dom.window.close();}
});
