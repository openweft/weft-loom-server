// main.ts — Svelte 5 entry. The actual UI lives in components ;
// this file just mounts App into #app.
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('no #app element');

mount(App, { target });
