/* automo.js means "automongo".
 * This library should be included most of the time, because implement high level functions about mongodb access.
 * all the functions implemented in routes, libraries, and whatsoever, should be implemented here.
 *
 * The module mongo3.js MUST be used only in special cases where concurrency wants to be controlled
 */
const _ = require('lodash');
const nconf = require('nconf');
const debug = require('debug')('lib:automo');
const debugLite = require('debug')('lib:automo:L');
const moment = require('moment');

const utils = require('../lib/utils');
const mongo3 = require('./mongo3');

async function getSummaryByPublicKey(publicKey, options) {
    /* this function return the basic information necessary to compile the
       landing personal page */
    const mongoc = await mongo3.clientConnect({concurrency: 1});

    const supporter = await mongo3.readOne(mongoc,
        nconf.get('schema').supporters, { publicKey });

    if(!supporter || !supporter.publicKey)
        throw new Error("Authentication failure");

    const metadata = await mongo3.readLimit(mongoc,
        nconf.get('schema').metadata, { publicKey: supporter.publicKey }, { savingTime: -1 },
        options.amount * 4, options.skip);
        // this        * 4 is because of the duplication stripping below

    const uniquified = _.reduce(metadata, function(memo, m) {
        if(m.videoId && memo.lastVideoId == m.videoId) 
            return memo;

        memo.lastVideoId = m.videoId;
        memo.acc.push(m);
        return memo;
    }, { acc: [], lastVideoId: null } );

    const unique = _.take(_.sortBy(uniquified.acc, { savingTime: -1}), options.amount);
    debug("%d - %d - %d", _.size(uniquified.acc), _.size(metadata), _.size(unique));

    const total = await mongo3.count(mongoc,
        nconf.get('schema').metadata, { publicKey: supporter.publicKey, title: {
            $exists: true
        } });

    await mongoc.close();

    const fields = [ 'metadataId', 'id','videoId', 'savingTime', 'title',
                     'producer', 'categories', 'related', 'views', 'relative',
                    'type', 'sections' ];

    const recent = _.map(unique, function(e) {
        e.relative = moment.duration( moment(e.savingTime) - moment() ).humanize() + " ago";
        return _.pick(e, fields);
    })
    return { supporter, recent, total };
}

async function getMetadataByPublicKey(publicKey, options) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});
    const supporter = await mongo3.readOne(mongoc, nconf.get('schema').supporters, { publicKey });

    if(!supporter)
        throw new Error("publicKey do not match any user");

    const metadata = await mongo3.readLimit(mongoc,
        nconf.get('schema').metadata, { publicKey: supporter.publicKey }, { savingTime: -1 },
        options.amount, options.skip);

    await mongoc.close();
    return { supporter, metadata };
};

async function getMetadataByFilter(filter, options) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});
    const metadata = await mongo3.readLimit(mongoc,
        nconf.get('schema').metadata, filter, { savingTime: -1 },
        options.amount, options.skip);

    await mongoc.close();
    return metadata;
};

async function getMetadataFromAuthor(filter, options) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});

    const sourceVideo = await mongo3.readOne(mongoc,
        nconf.get('schema').metadata, filter);

    if(!sourceVideo || !sourceVideo.id)
        throw new Error("Video not found, invalid videoId");

    const videos = await mongo3.readLimit(mongoc,
        nconf.get('schema').metadata, { authorSource: sourceVideo.authorSource}, 
        { savingTime: -1 }, options.amount, options.skip);

    const total = await mongo3.count(mongoc,
        nconf.get('schema').metadata, { authorSource: sourceVideo.authorSource});

    await mongoc.close();
    return { 
        content: videos,
        total,
        pagination: options,
        authorName: sourceVideo.authorName,
        authorSource: sourceVideo.authorSource,
    }
};

async function getRelatedByWatcher(publicKey, options) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});

    const supporter = await mongo3.readOne(mongoc, nconf.get('schema').supporters, { publicKey });
    if(!supporter)
        throw new Error("publicKey do not match any user");

    const related = await mongo3
        .aggregate(mongoc, nconf.get('schema').metadata, [
            { $match: { 'watcher': supporter.p }},
            { $sort: { savingTime: -1 }},
            { $skip: options.skip },
            { $limit : options.amount },
            { $lookup: { from: 'videos', localField: 'id', foreignField: 'id', as: 'videos' }},
            { $unwind: '$related' }
        ]);
    await mongoc.close();
    return related;
}

async function getVideosByPublicKey(publicKey, filter) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});

    const supporter = await mongo3.readOne(mongoc, nconf.get('schema').supporters, { publicKey });
    if(!supporter)
        throw new Error("publicKey do not match any user");

    const selector = _.set(filter, 'p', supporter.p);
    debug("getVideosByPublicKey with flexible selector (%j)", filter);
    const matches = await mongo3.read(mongoc, nconf.get('schema').videos, selector, { savingTime: -1 });
    await mongoc.close();

    return matches;
};

async function getFirstVideos(when, options) {
    // expected when to be a moment(), TODO assert when.isValid()
    // function used from routes/rsync
    const mongoc = await mongo3.clientConnect({concurrency: 1});
    const selected = await mongo3
        .readLimit(mongoc,
            nconf.get('schema').videos,
            { savingTime: { $gte: new Date(when.toISOString()) }}, { savingTime: 1 },
            options.amount, options.skip);
    await mongoc.close();
    return selected;
};

async function deleteEntry(publicKey, id) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});
    const supporter = await mongo3.readOne(mongoc, nconf.get('schema').supporters, { publicKey });
    if(!supporter)
        throw new Error("publicKey do not match any user");

    const video = await mongo3.deleteMany(mongoc, nconf.get('schema').videos, { id: id, p: supporter.p });
    const metadata = await mongo3.deleteMany(mongoc, nconf.get('schema').metadata, { id: id });
    await mongoc.close();
    return { video, metadata };
};

async function getRelatedByVideoId(videoId, options) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});
    const related = await mongo3
        .aggregate(mongoc, nconf.get('schema').metadata, [
            { $match: { videoId: videoId } },
            { $sort: { savingTime: -1 }},
            { $skip: options.skip },
            { $limit : options.amount },
            // { $lookup: { from: 'videos', localField: 'id', foreignField: 'id', as: 'videos' }},
            // TODO verify how this work between v1 and v2 transition
            { $unwind: '$related' },
            { $sort: { savingTime: -1 }}
        ]);
    await mongoc.close();
    debug("Aggregate of getRelated: %d entries", _.size(related));
    return _.map(related, function(r) {
        return {
            id: r.id.substr(0, 20),
            videoId: r.related.videoId,
            title: r.related.title,
            verified: r.related.verified,
            source: r.related.source,
            vizstr: r.related.vizstr,
            foryou: r.related.foryou,
            suggestionOrder: r.related.index,
            displayLength: r.related.displayTime,
            watched: r.title,
            since: r.publicationString,
            credited: r.authorName,
            channel: r.authorSource,
            savingTime: r.savingTime,
            watcher: r.watcher,
            watchedId: r.videoId,
        };
    });
}

async function write(where, what) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});
    let retv;
    try {
        await mongo3.insertMany(mongoc, where, what);
        retv = { error: false, ok: _.size(what) };
    } catch(error) {
        debug("%s %j", error.message, _.keys(errors));
        retv = { error: true, info: error.message };
    } finally {
        await mongoc.close();
        return retv;
    }
}

async function tofu(publicKey, version) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});

    let supporter = await mongo3.readOne(mongoc,
        nconf.get('schema').supporters, { publicKey });

    if( !! _.get(supporter, '_id') ) {
        supporter.lastActivity = new Date();
        supporter.version = version;
        await mongo3.updateOne(mongoc,
            nconf.get('schema').supporters, { publicKey }, supporter);
    } else {
        supporter = {};
        supporter.publicKey = publicKey;
        supporter.version = version;
        supporter.creationTime = new Date();
        supporter.lastActivity = new Date();
        supporter.p = utils.string2Food(publicKey);
        debug("TOFU: new publicKey received, from: %s", supporter.p);
        await mongo3.writeOne(mongoc,
            nconf.get('schema').supporters, supporter);
    }

    await mongoc.close();
    return supporter;
}

async function getLastHTMLs(filter, skip) {

    const HARDCODED_LIMIT = 4;
    const mongoc = await mongo3.clientConnect({concurrency: 1});

    const htmls = await mongo3.readLimit(mongoc,
        nconf.get('schema').htmls, filter,
        { savingTime: 1}, 
        HARDCODED_LIMIT, 
        skip ? skip : 0);

    if(_.size(htmls)) 
        debug("getLastHTMLs: %j -> %d (overflow %s)%s", filter, _.size(htmls),
            (_.size(htmls) == HARDCODED_LIMIT), skip ? "skip " + skip : "");

    mongoc.close();
    return {
        overflow: _.size(htmls) == HARDCODED_LIMIT,
        content: htmls
    }
}

async function updateMetadata(html, newsection) {

    async function markHTMLandClose(mongoc, html, retval) {
        await mongo3.updateOne(mongoc, nconf.get('schema').htmls, { id: html.id }, { processed: true });
        await mongoc.close();
        return retval;
    }

    // we should look at the same metadataId in the 
    // metadata collection, and update new information
    // if missing 
    const mongoc = await mongo3.clientConnect({concurrency: 1});
    let exists = null;

    if(!html.metadataId) {
        debug("metadataId is not an ID!");
        return await markHTMLandClose(mongoc, html, null);
    }

    try {
        exists = await createMetadataEntry(mongoc, html, newsection);
        debug("Created metadata %s from %s with %s", html.metadataId, html.href, html.selector);
    } catch(e) {
        /* the read+write in a single thread seems is not enough to guarantee */
        if(e.code == 11000) {
            exists = await updateMetadataEntry(mongoc, html, newsection);
        } else {
            debug("Unexpected error: %s (%d)", e.message, e.code);
        }
    }
    return await markHTMLandClose(mongoc, html, exists);
}

async function createMetadataEntry(mongoc, html, newsection) {
    /* this is not exported, it is used only by updateMetadata */
    exists = {};
    exists.id = html.metadataId;
    exists.publicKey = html.publicKey;
    exists.savingTime = html.savingTime;
    exists.clientTime = html.clientTime;
    exists.version = 2;
    exists = _.extend(exists, newsection);    
    await mongo3.writeOne(mongoc, nconf.get('schema').metadata, exists);
    return exists;
}

async function updateMetadataEntry(mongoc, html, newsection) {
    /* this is not exported, it is used only by updateMetadata */
    let updates = 0;
    let exists = await mongo3.readOne(mongoc, nconf.get('schema').metadata, { id: html.metadataId });
    if(!exists)
        exists = {};

    /* this is meant to add only fields with values, and to notify duplicated
     * conflictual metadata mined, or extend labels as list */
    const up = _.reduce(newsection, function(memo, value, key) {

        if(!value)
            return memo;

        let current = _.get(memo, key);
        /* TODO should be compared if there is any update or any difference */
        _.set(memo, key, value);
        updates++;

        return memo;
    }, exists);    

    debug("Updating metadata %s with %s (total of %d updates)",
        html.metadataId, html.selector, updates);
    let r = await mongo3.updateOne(mongoc, nconf.get('schema').metadata, { id: html.metadataId }, up );
    return r;
}

async function getRandomRecent(minTime, maxAmount) {
    const mongoc = await mongo3.clientConnect({concurrency: 1});

    const supporters = await mongo3.readLimit(mongoc, nconf.get('schema').supporters, {
        lastActivity: { $gt: minTime }
    }, { lastActivity: -1}, maxAmount, 0);

    const validExamples = [];
    for (supporter of supporters) {
        let i = await mongo3.count(mongoc, nconf.get('schema').metadata, {
            publicKey: supporter.publicKey,
            type: 'video'
        });
        if(i > 2)
            validExamples.push(supporter);
    }

    await mongoc.close();
    return validExamples;
}

async function getMixedDataSince(schema, since, maxAmount) {                               

    const mongoc = await mongo3.clientConnect({concurrency: 1});                           
    const retContent = [];

    for (let cinfo of schema) {                                                            
        let columnName = _.first(cinfo);                                                   
        let fields = _.nth(cinfo, 1);                                                      
        let timevar = _.last(cinfo);                                                       
        let filter = _.set({}, timevar, { $gt: since});                                    
                                                                                           
        /* it prefer the last samples, that's wgy the sort -1 */                           
        const r = await mongo3.readLimit(mongoc,                                           
            nconf.get('schema')[columnName], filter, _.set({}, timevar, -1),               
            maxAmount, 0);                                                                 
                                                                                           
        /* if an overflow is spotted, with message is appended */                          
        if(_.size(r) == maxAmount)                                                         
            retContent.push({                                                              
                template: 'info',                                                          
                message: 'Whoa, too many! capped limit at ' + maxAmount,                   
                subject: columnName,                                                       
                id: "info-" + _.random(0, 0xffff),                                         
                timevar: new Date(                                                         
                    moment(_.last(r)[timevar]).subtract(1, 'ms').toISOString()             
                ),                                                                         
                /* one second is added to be sure the alarm message appears after the      
                 * last, and not in between the HTMLs/metadatas */                         
            });                                                                            
                                                                                           
        /* every object has a variable named 'timevar', and the $timevar we                
         * used to pick the most recent 200 is renamed as 'timevar'. This allow            
         * us to sort properly the sequence of events happen server side */                
        _.each(r, function(o) {                                                            
            let good = _.pick(o, fields)                                                   
            good.template = columnName;                                                    
            good.relative = _.round(                                                       
                moment.duration( moment() - moment(o[timevar]) ).asSeconds()               
            , 1);                                                                          
                                                                                           
            good['timevar'] = new Date(o[timevar]);                                        
            good.printable = moment(good['timevar']).format('HH:mm:ss');                   
            _.unset(good, timevar);                                                        
                                                                                           
            /* supporters, or who know in the future, might have not an 'id'.              
               it is mandatory for client side logic, so it is attributed random */        
            if(_.isUndefined(good.id))                                                     
                _.set(good, 'id', "RANDOM-" + _.random(0, 0xffff));                        
                                                                                           
            retContent.push(good);                                                         
        });                                                                                
    }                                                                                      
                                                                                           
    mongoc.close();                                                                        
    return retContent;     
} 

module.exports = {
    /* used by routes/personal */
    getSummaryByPublicKey,
    getMetadataByPublicKey,
    getRelatedByWatcher,
    getVideosByPublicKey,
    deleteEntry,

    /* used by routes/public */
    getMetadataByFilter,
    getMetadataFromAuthor,
    getRandomRecent,

    /* used by routes/rsync */
    getFirstVideos,

    /* used by public/videoCSV */
    getRelatedByVideoId,

    /* used in events.js processInput */
    tofu,
    write,

    /* used in parserv2 */
    getLastHTMLs,
    updateMetadata,

    /* used by monitor */
    getMixedDataSince,
};
