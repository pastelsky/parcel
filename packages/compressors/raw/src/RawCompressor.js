// @flow
import {Compressor} from '@parcel/plugin';

export default (new Compressor({
  compress({contents}) {
    return {contents};
  },
}): Compressor);
