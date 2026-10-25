// Feature route modules, tried in order after the core routes in main.mjs.
import capacity from './capacity.mjs';
import messages from './messages.mjs';
import ops from './ops.mjs';
import publicRoutes from './public.mjs';
import handover from './handover.mjs';
import settlement from './settlement.mjs';
export const routeModules = [capacity, messages, ops, handover, settlement];
export const publicRouteModules = [publicRoutes];
