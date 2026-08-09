import {parkFile, isPdf} from './handoff.js';

/* The home page's own drop zone. Its only job is to accept a file and get out
   of the way — the editor does the reading. */
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');

async function hand(file) {
  if (!isPdf(file)) {
    alert('That is not a PDF file.');
    return;
  }
  try {
    await parkFile(file);
    location.href = './editor.html';
  } catch {
    /* Private browsing can refuse IndexedDB. Sending the user to the editor
       with nothing parked would show them an empty document and no explanation,
       so say what happened here instead. */
    alert('This browser would not let the page store the file. Open the editor and choose it there.');
  }
}

['dragenter', 'dragover'].forEach(name =>
  drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('over'); }));

['dragleave', 'drop'].forEach(name =>
  drop.addEventListener(name, e => { e.preventDefault(); drop.classList.remove('over'); }));

drop.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) hand(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) hand(fileInput.files[0]);
});
