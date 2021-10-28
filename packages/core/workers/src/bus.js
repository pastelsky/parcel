// @flow
import EventEmitter from 'events';
import {child} from './childState';

// $FlowFixMe
const BUS_LOCATION = process.browser
  ? '@parcel/workers/src/bus.js'
  : __filename;

class Bus extends EventEmitter {
  emit(event: string, ...args: Array<any>): boolean {
    if (child) {
      child.workerApi.callMaster(
        {
          location: BUS_LOCATION,
          method: 'emit',
          args: [event, ...args],
        },
        false,
      );
      return true;
    } else {
      return super.emit(event, ...args);
    }
  }
}

export default (new Bus(): Bus);
