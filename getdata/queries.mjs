// three different queries

const boundsString = (bounds) => `${Math.min(...bounds.y)},${Math.min(...bounds.x)},${Math.max(...bounds.y)},${Math.max(...bounds.x)}`;

const countries = (bounds) => `
[out:json][timeout:180];
rel["boundary"="administrative"]["admin_level"="2"]["ISO3166-1"!="US"](${boundsString(bounds)});
way(r)["maritime"!="yes"](${boundsString(bounds)});
out body;
>;
out skel qt;
`;

const states = (bounds) => `
[out:json];
rel['admin_level'='4'](${boundsString(bounds)});
way(r);
out;
// print results
out body;
>;
out skel qt;
`;

const counties = (bounds) => `
[out:json][timeout:600];
rel['admin_level'='6'](${boundsString(bounds)});
way(r);
out;
out body;
>;
out skel qt;
`;

const roads = (bounds) => `
[out:json][timeout:600];
relation["type"="route"]["route"="road"]["network"="US:I"](${boundsString(bounds)});
out body;
>;
out skel qt;
`;

const minorRoads = (bounds) => `
[out:json][timeout:600];
way['highway'~'primary'](${boundsString(bounds)});
out body;
>;
out skel qt;
`;

export default {
	roads,
	minorRoads,
	counties,
	states,
	countries,
};
