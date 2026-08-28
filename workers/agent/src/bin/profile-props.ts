/**
 * Print one profile's build properties as `key=value` lines, for `deploy/apply-device-profile.sh`.
 *
 * Exists so the property list has exactly ONE definition. The alternative — a copy of the same
 * key/value pairs written out in bash — would be two lists that drift, and the failure mode of that
 * drift is silent: the device boots, reports a half-changed identity, and looks fine until somebody
 * reads `ro.product.vendor.model` and finds Cuttlefish under a Samsung name.
 *
 *   node --experimental-strip-types src/bin/profile-props.ts galaxy-s25-ultra
 */
import { DEVICE_PROFILES, profileById } from '../devices/profiles.ts';

const id = process.argv[2];
const profile = profileById(id);
if (!profile) {
  console.error(
    id
      ? `Unknown profile "${id}". Known: ${Object.keys(DEVICE_PROFILES).join(', ')}`
      : `Usage: profile-props.ts <profile-id>   (known: ${Object.keys(DEVICE_PROFILES).join(', ')})`,
  );
  process.exit(2);
}

for (const [key, value] of Object.entries(profile.props)) console.log(`${key}=${value}`);
