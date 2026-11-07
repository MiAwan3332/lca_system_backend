import mongoose from 'mongoose';
import { accessContext } from './accessContext.js';

// Installed before application models compile. Filtering happens before pagination/aggregation.
mongoose.plugin((schema) => {
  for (const operation of ['find', 'findOne', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
    schema.pre(operation, function () {
      const scope = accessContext.getStore()?.modelFilters?.[this.model.modelName];
      if (scope) this.setQuery({ $and: [this.getFilter(), scope] });
    });
  }
  schema.pre('aggregate', function () {
    const scope = accessContext.getStore()?.modelFilters?.[this._model.modelName];
    if (!scope) return;
    if (this.pipeline()[0]?.$geoNear || this.pipeline()[0]?.$search) throw Object.assign(new Error('Scoped search requires an explicit authorization adapter'), { status: 403 });
    const context = accessContext.getStore();
    const collections = new Map(Object.values(mongoose.models).map((model) => [model.collection.name, context.modelFilters?.[model.modelName]]));
    const protectJoins = (pipeline) => {
      for (const stage of pipeline) {
        if (stage.$unionWith || stage.$graphLookup || stage.$out || stage.$merge) throw Object.assign(new Error('This aggregate requires an all-records grant'), { status: 403 });
        if (stage.$lookup) {
          const filter = collections.get(stage.$lookup.from);
          if (!filter) throw Object.assign(new Error('Joined collection requires an explicit scope adapter'), { status: 403 });
          stage.$lookup.pipeline = [{ $match: filter }, ...(stage.$lookup.pipeline || [])];
          protectJoins(stage.$lookup.pipeline);
        }
        if (stage.$facet) Object.values(stage.$facet).forEach(protectJoins);
      }
    };
    protectJoins(this.pipeline());
    this.pipeline().unshift({ $match: scope });
  });
});
