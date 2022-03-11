// @flow strict-local

// flowlint-next-line untyped-import:off
import {analyticsClient, userTypes} from '@atlassiansox/analytics-node-client';
import os from 'os';
import {hashString} from '@parcel/hash';
import getMachineModel from './getMachineModel';

const HASHED_EMAIL = hashString(`${os.userInfo().username}@${os.hostname()}`);

let client;
if (
  process.env.PARCEL_BUILD_ENV === 'production' &&
  process.env.PARCEL_ANALYTICS_DISABLE == null
) {
  client = analyticsClient({
    env: 'prod',
    product: 'parcel',
  });
}

// This is inlined during the build process
const PARCEL_COMMIT = process.env.BITBUCKET_COMMIT;
const TOTAL_MEM = os.totalmem();
const CPUS = os.cpus();
const machineModelPromise = getMachineModel();

const analytics = {
  track: async ({
    action,
    subject,
    subjectId,
    additionalAttributes,
  }: {|
    action: string,
    subject: string,
    subjectId?: ?string,
    additionalAttributes: {[string]: mixed, ...},
  |}): Promise<mixed> => {
    const memoryUsage = process.memoryUsage();
    const trackEvent = {
      userId: HASHED_EMAIL,
      userIdType: userTypes.HASHED_EMAIL,
      trackEvent: {
        source: 'analyticsReporter',
        action,
        actionSubject: subject,
        actionSubjectId: subjectId,
        attributes: {
          ...additionalAttributes,
          timestamp: new Date(),
          memoryRss: memoryUsage.rss,
          memoryHeapTotal: memoryUsage.heapTotal,
          memoryHeapUsed: memoryUsage.heapUsed,
          memoryTotal: TOTAL_MEM,
          parcelCommit: PARCEL_COMMIT ?? null,
          machineModel: await machineModelPromise,
          cpuCount: CPUS.length,
          firstCpuModel: CPUS[0].model,
          firstCpuSpeed: CPUS[0].speed,
        },
      },
      os: {
        name: os.platform(),
        // $FlowFixMe[prop-missing] Added in Node 12.17.0
        version: os.version(),
      },
    };

    if (process.env.PARCEL_ANALYTICS_DEBUG != null) {
      // eslint-disable-next-line no-console
      console.log('analytics:track', trackEvent);
    }

    if (client != null) {
      try {
        return await client.sendTrackEvent(trackEvent);
      } catch (err) {
        if (process.env.ANALYTICS_DEBUG != null) {
          // eslint-disable-next-line no-console
          console.error('Failed to send analytics', err);
        }
        // Don't let a failure to report analytics crash Parcel
      }
    }
  },

  trackSampled: (
    sampleRate: number,
    getEvent: () => {|
      action: string,
      subject: string,
      subjectId: ?string,
      additionalAttributes: {[string]: mixed, ...},
    |},
  ): Promise<mixed> => {
    if (Math.random() < 1 / sampleRate) {
      const event = getEvent();
      event.additionalAttributes.sampleRate = sampleRate;
      return analytics.track(event);
    }

    return Promise.resolve();
  },
};

export default analytics;