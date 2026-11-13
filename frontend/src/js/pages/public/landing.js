// Stats, departments and the three best-rated doctors are declared in index.html; this adds booking
import { initPublic } from '../../core/shell.js';
import { directory } from './directory.js';

initPublic();
directory('#doctors');
