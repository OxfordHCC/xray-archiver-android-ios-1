/* eslint max-len: 0 */

const config = require('/etc/xray/config_ios.json');
const pg = require('pg');
const logger = require('../util/logger');

class SchemaClient extends pg.Client {
    getStartupConf() {
        const options = {
        	search_path: config.db_schema
        };
        return {
          ...super.getStartupConf(),
          ...options,
        };

    	return super.getStartupConf();
	}
}

class DB {
    /**
     *  DB Class constructor - Initialises all config for pg db connections
     *  as well as a pool for connecting to xray db.
     */
    constructor(module) {
        // WISHLIST: initialise pool for desired db option from the config here.
        const dbCfg = config.db;
        dbCfg.user = config[module].db.user;
        dbCfg.password = config[module].db.password;
        dbCfg.max = 10;
        dbCfg.idleTimeoutMillis = 30000;
        dbCfg.Client = SchemaClient;

        // this initializes a connection pool
        // it will keep idle connections open for 30 seconds
        // and set a limit of maximum 10 idle clients
        this.pool = new pg.Pool(dbCfg);

        this.pool.on('error', (err) => {
            logger.err('idle client error', err.message, err.stack);
        });
    }

    // export the query method for passing queries to the pool
    query(text, values) {
        try {
            if (values) logger.debug('query:', text, values);
            else logger.debug('query:', text, values);
            return this.pool.query(text, values);
        } catch (err) {
            logger.err('Error With Postgres Query');
            throw err;
        }
    }

    async connect() {
        try {
            logger.debug('connecting to db pool');
            const ret = await this.pool.connect();
            ret.lquery = (text, values) => {
                if (values) logger.debug('lquery:', text, values);
                else logger.debug('lquery:', text);
                return ret.query(text, values);
            };

            return ret;
        } catch (err) {
            logger.err('Failed To Connect To Pool', err);
            throw err;
        }
    }

    async insertDev(dev) {
        try {
            let res = await this.query('SELECT id FROM developers WHERE $1 = ANY(email)', [dev.email]);
            if (res.rowCount > 0) {
                logger.debug('developer with email %s exists', dev.email);
                return res.rows[0].id;
            }

            logger.debug('inserting developer with email %s', dev.email);

            // maybe dev id needs to be URL encoded?
            const storeSite = `https://play.google.com/store/apps/developer?id=${dev.id}`;
            res = await this.query('INSERT INTO developers(email,name,store_site,site) VALUES ($1, $2, $3, $4) RETURNING id', [
                [dev.email], dev.name, storeSite, dev.site,
            ]);
            return res.rows[0].id;
        } catch (err) {
            logger.err('Error inserting developer details:', err);
        }
        // TODO: this is probably not what we want to do?
        return false;
    }

    async updatedLastAltChecked(appID) {
        const client = await this.connect();

        try {
            await client.lquery('UPDATE app_versions SET last_alt_checked = CURRENT_TIMESTAMP where app = $1', [appID]);
        } catch (err) {
            logger.err('Error updating alt app last checked date:', err);
        } finally {
            client.release();
        }
    }

    async insertAltApp(altApp) {
        // check if the current alt app exists in the db and has been analysed.
        let isCollected = false;

        try {
            if (altApp.gPlayID != '') {
                const analysedRes = await this.query('SELECT analyzed from app_versions where app = $1 ', [altApp.gPlayAppID]);
                if (analysedRes.rowCount > 0) {
                    isCollected = true;
                }
            }
        } catch (err) {
            logger.err('Error checking for existing app id', err);
            throw err;
        }

        try {
            const client = await this.connect();
            logger.debug('Connected');

            const checkRes = await client.lquery(
                'SELECT * FROM alt_apps WHERE alt_app_title = $1 and app_id = $2', [altApp.title, altApp.appID]
            );

            logger.debug(checkRes.rowCount);

            if (checkRes.rowCount == 0) {
                try {
                    await client.lquery('BEGIN');
                    await client.lquery(
                        'INSERT INTO alt_apps( \
                        app_id, alt_app_title, alt_to_url, g_play_url, g_play_id, icon_url, official_site_url, is_scraped) \
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
                            altApp.appID,
                            altApp.title,
                            altApp.altToURL,
                            altApp.gPlayURL,
                            altApp.gPlayAppID,
                            altApp.altAppIconURL,
                            altApp.officialSiteURL,
                            isCollected,
                        ]);
                    logger.debug(`${altApp.title} added to DB`);
                    await client.lquery('COMMIT');
                } catch (err) {
                    logger.err('Error with previous query:', err);
                    await client.lquery('ROLLBACK');
                } finally {
                    client.release();
                }
            } else {
                logger.debug('%s already exists, skipping.', altApp.title);
                client.release();
            }
        } catch (err) {
            logger.err('Error inserting alt app data.', err);
            throw err;
        }
    }

    async updateServerLocation(versionID, serverLocation) {
        try {
            await this.query(
                'update app_versions set apk_server_location = $1 where id = $2',
                [serverLocation, versionID]
            );
        } catch (err) {
            logger.err(
                `Unable to set apk_server_location to ${serverLocation} for
                app version: ${versionID}. Error: ${err}`
            );
        }
    }

    async updateAppVersionHasAPKFlag(versionID, hasAPK) {
        try {
            await this.query(
                'update app_versions set has_apk_stored = $1 where id = $2',
                [hasAPK, versionID]
            );
        } catch (err) {
            logger.err(
                `Unable to set hasAPK flag to ${hasAPK ? 'True' : 'False'}
                for app version ID: ${versionID}. Error: ${err}`
            );
        }
    }

    async updateAppVersionAPKLocation(versionID, apkLocation) {
        try {
            await this.query(
                'update app_versions set apk_location = $1 where id = $2',
                [apkLocation, versionID]
            );
        } catch (err) {
            logger.err(
                `Unable to set apk_location for version ID:${versionID}.
                Desired location string: ${apkLocation}.
                Error: ${err}`
            );
        }
    }

    async getAppsToFindAltsForThatHaventYetHadThemFound(limit) {
        try {
            const res = await this.query(
                'SELECT a.title, v.app FROM app_versions v FULL OUTER JOIN playstore_apps a \
                ON (a.id = v.id) \
                    WHERE v.app NOT IN (SELECT app_id AS app FROM alt_apps) \
                         ORDER BY last_alt_checked NULLS FIRST LIMIT $1', [limit]);

            if (res.rowCount <= 0) {
                logger.debug('No apps need alternatives to be searched for. Or something has screwed up');
            }

            logger.info(res.rowCount, 'Apps need alternatives to be scraped.');
            return res.rows;
        } catch (err) {
            logger.err('Error fetching alternative apps');
            throw err;
        }
    }

    async queryAppsToDownload(batch) {
        try {
            const res = await this.query('SELECT * FROM (SELECT * FROM app_versions ORDER BY last_dl_attempt) AS versions FULL OUTER JOIN playstore_apps ON (playstore_apps.id = versions.id ) WHERE downloaded = False AND free = true LIMIT $1 ', [batch]);

            if (res.rowCount <= 0) {
                return Promise.reject('No downloads found. Consider slowing down downloader or speeding up scraper');
            }
            logger.info('Found apps to download:', res.rowCount);
            return res.rows;
        } catch (err) {
            logger.err('Error finding apps to download:', err);
            throw err;
        }
    }

    async updateDownloadedApp(
        app,
        appSaveInfo={
            appSavePath: '',
            appSaveFS: '',
            appSaveFSName: '',
            appSavePathRoot: '',
            appSaveUUID: '',
        },
        serverLocation='localhost') {
        try {
            await this.query(
                `
                UPDATE
                    app_versions
                SET
                    downloaded=True,
                    has_apk_stored=True,
                    apk_location        =   $1,
                    apk_server_location =   $2,
                    apk_filesystem      =   $3,
                    apk_filesystem_name =   $4,
                    apk_location_root   =   $5,
                    apk_location_uuid   =   $6
                WHERE
                    app                 =   $7`,
                [
                    appSaveInfo.appSavePath,
                    serverLocation,
                    appSaveInfo.appSaveFS,
                    appSaveInfo.appSaveFSName,
                    appSaveInfo.appSavePathRoot,
                    appSaveInfo.appSaveUUID,
                    app.app,
                ]
            );
        } catch (err) {
            logger.err('Error updating app version flags:', err);
            throw err;
        }
    }

    async updatedDlAttempt(app) {
        try {
            await this.query('UPDATE app_versions SET last_dl_attempt=CURRENT_TIMESTAMP WHERE app = $1', [app.app]);
        } catch (err) {
            logger.err('Error updaing app version last download attempt date:', err);
            throw err;
        }
    }

    async queryAppsToAnalyse(batch, analysisVersion) {
        logger.info('Getting Apps From the DB to Analyse.');
        try {
            const res = await this.query('SELECT \
                        v.id, \
                        v.app, \
                        v.store, \
                        v.region, \
                        v.version, \
                        v.screen_flags, \
                        v.icon, \
                        v.apk_location, \
                        v.apk_location_root, \
                        v.apk_location_uuid, \
                        v.manifest, \
                        v.files, \
                        v.frameworks \
                    FROM \
                        app_versions v FULL OUTER JOIN playstore_apps p ON v.id = p.id \
                    WHERE \
                        (NOT v.analyzed OR analysis_version IS NULL OR (analysis_version IS NOT NULL AND analysis_version < $1)) \
                    AND \
                        v.downloaded \
                    ORDER BY \
                        v.last_analyze_attempt NULLS FIRST, \
                        p.max_installs USING > \
                    LIMIT $2', [analysisVersion, batch]);

            if (res.rowCount <= 0) {
                return Promise.reject('No apps found.');
            }
            logger.info('Found apps to analyse:', res.rowCount);
            return res.rows;
        } catch (err) {
            logger.err('Error finding apps to analyse:', err);
            throw err;
        }
    }

    async updatedAnalyseAttempt(app) {
        try {
            await this.query('UPDATE app_versions SET last_analyze_attempt=CURRENT_TIMESTAMP WHERE id = $1', [app.id]);
        } catch (err) {
            logger.err('Error updating app version last analyse attempt date:', err);
            throw err;
        }
    }

    async updateAppFrameworks(app, frameworks) {
        try {
            await this.query('UPDATE app_versions SET frameworks = $1 WHERE id = $2', [frameworks, app.id]);
        } catch (err) {
            logger.err('Error setting frameworks:', err);
            throw err;
        }
    }

    async updateAppAnalysis(app, files, manifestJson, trackers, trackerSettings, bundles, permissions, analysisVersion) {
        try {
            await this.query('UPDATE app_versions SET analyzed = true, files = $1, manifest = $2, trackers = $3, trackerSettings = $4, bundles = $5, permissions = $6, analysis_version = $7 WHERE id = $8', [files, manifestJson, trackers, trackerSettings, bundles, permissions, analysisVersion, app.id]);
        } catch (err) {
            logger.err('Error updating app analysis:', err);
            throw err;
        }
    }

    async getAppData() {
        try {
            logger.debug('Fetching Search Terms');
            const res = await this.query('SELECT search_term FROM search_terms WHERE age(last_searched) > interval \'1 month\'');
            logger.debug(`${res.rows.length} terms fetched`);
            return res.rows;
        } catch (err) {
            logger.err('Error getting search terms', err);
            throw err;
        }
    }

    /**
     *  Query the search_terms table to get a list of terms that are stale
     */
    async getStaleSearchTerms() {
        try {
            logger.debug('Fetching Search Terms');
            const res = await this.query('SELECT search_term FROM search_terms WHERE age(last_searched) > interval \'1 month\'');
            logger.debug(`${res.rows.length} terms fetched`);
            return res.rows;
        } catch (err) {
            logger.err('Error getting search terms', err);
            throw err;
        }
    }

    /**
     *
     */
    async insertCompanyDomain(company, domain, type) {
        logger.debug(`Inserting - Company: ${company}  Domain: ${domain}`);
        try {
            logger.debug(`Checking if Company: ${company} & Domain: ${domain} already exist.`);
            const checkRes = await this.query('SELECT * FROM company_domains WHERE company = $1 and domain = $2', [company, domain]);
            if (checkRes.rowCount != 0) {
                logger.debug('Company and Domain Already Exist.');
                return;
            }
            logger.debug('Company and Domain don\'t exist. Inserting now.');
            await this.query('INSERT INTO company_domains VALUES($1, $2, $3)', [company, domain, type]);
        } catch (err) {
            logger.err(`Error inserting company domain: ${err}`);
        }
    }

    /**
     *  Insert A Manually Curated App and ID into the Database
     */
    async insertManualSuggestion(altPair) {
        logger.debug(`Inserting - Source: ${altPair.source}  Alt:${altPair.alt}`);

        try {
            logger.debug(` -- Checking if ${altPair.source} and ${altPair.alt} exists in db. -- `);
            const checkRes = await this.query('SELECT * FROM manual_alts WHERE source_id = $1 and alt_id = $2 limit 1', [altPair.source, altPair.alt]);
            logger.debug(`${checkRes.rowCount} rows found for ${altPair.source} and ${altPair.alt}`);
            if (checkRes.rowCount == 0) {
                logger.debug(`${altPair.source} and ${altPair.alt} in the manual alt table`);
                await this.query('INSERT INTO manual_alts VALUES ($1, $2)', [altPair.source, altPair.alt]);
                logger.debug(`${altPair.source} and ${altPair.alt} Added to the DB.`);
            } else {
                logger.debug(`${altPair.source} and ${altPair.alt} Already Exist!`);
            }
        } catch (err) {
            logger.err(`Error inserting manual suggestion ${err}`);
        }
    }

    /**
     * Sets the last_searched date of a specified search term to be the current date.
     * Used to track 'stale' search terms.
     */
    async updateLastSearchedDate(searchTerm) {
        logger.debug(`Setting last searched date for ${searchTerm} to current date`);
        const client = await this.connect();
        try {
            logger.debug('connected');

            logger.debug(`checking if ${searchTerm} exists in db.`);
            const checkRes = await client.lquery('SELECT search_term FROM search_terms WHERE search_term = $1', [searchTerm]);
            logger.debug(`${checkRes.rowCount} rows found for ${searchTerm}`);
            let updateRes;
            if (checkRes.rowCount > 0) {
                logger.debug(`${searchTerm} exists, updating last searched date.`);
                updateRes = await client.lquery('UPDATE search_terms SET last_searched = CURRENT_DATE WHERE search_term = $1', [searchTerm]);
            }
            client.release();
            return updateRes;
        } catch (err) {
            logger.err('Error updating last searched date for search terms:', err);
            client.release();
            throw err;
        }
    }

    /**
     *  Add a search term to the table if it doesn't already exist.
     */
    async insertSearchTerm(searchTerm) {
        const client = await this.connect();
        logger.debug('Connected');
        try {
            logger.debug(`Checking if ${searchTerm} exists before adding to search_terms`);
            const checkRes = await client.lquery('SELECT search_term FROM search_terms WHERE search_term = $1', [searchTerm]);

            if (checkRes.rowCount == 0) {
                try {
                    await client.lquery('BEGIN');
                    await client.lquery('INSERT INTO search_terms VALUES ($1, \'epoch\')', [searchTerm]);
                    logger.debug(`${searchTerm} added to DB`);
                    await client.lquery('COMMIT');
                } catch (err) {
                    logger.err('Error with previous query:', err);
                    await client.lquery('ROLLBACK');
                } finally {
                    client.release();
                }
            } else {
                logger.debug('%s already exists, skipping.', searchTerm);
                client.release();
            }
        } catch (err) {
            logger.err('Error inserting search term into the database', err);
            client.release();
            throw err;
        }
    }

    /**
     *  Check if app already exists in the apps DB. used before attempting to log again.
     */
    async doesAppExist(app) {
        try {
            const res = await this.query('SELECT * FROM apps WHERE id = $1', [app.appId]);
            logger.debug(`app query res count: ${res.rowCount}`);
            return res.rowCount > 0;
        } catch (err) {
            logger.err('Error checking if app exists in the database:', err);
            throw err;
        }
    }

    async selectAppVersion(appId) {
        try {
            const res = await this.query('select * from app_versions where id = $1', [appId]);
            return res.rows[0];
        } catch (err) {
            logger.err(`Unable to select App Version with ID: ${appId}. Error: ${err}`);
            throw err;
        }
    }

    async selectAllAppPackageNameVersionNumbers() {
        try {
            const res = await this.query('select * from apps');
            return res.rows;
        } catch (err) {
            logger.err(`Error selecting apps and version id's. Errrrrror: ${err}`);
            throw err;
        }
    }

    /**
     *  Inserts App Data scraped from the google play store into the DB.
     */
    async insertAppleApp(app, region) {
        logger.debug('Inserting Dev Information. ');
        const devId = await this.insertDev({
            name: app.developer,
            id: app.developerId,
            email: app.developerWebsite, /* TODO: Change, not provided in iOS search request */
            site: app.developerWebsite,
        });

        let appExists = false,
            verExists = false;
        let verId;
        const res = await this.query('SELECT * FROM apps WHERE id = $1', [app.appId]);

        if (res.rowCount != 0) {
            appExists = true;
            // app exists in database, check if version does as well
            const res1 = await this.query(
                'SELECT id FROM app_versions WHERE app = $1 AND store = $2 AND region = $3 AND version = $4', [app.appId, 'play', region, app.version]);

            if (res1.rowCount > 0) {
                // app version is also in database
                verExists = true;
                verId = res1.rows[0].id;
            }
        }

        const client = await this.connect();
        logger.debug('Connected');

        await client.lquery('BEGIN'); // maybe this should be inside the try?
        try {
            if (!verExists) {
                if (!appExists) {
                    await client.lquery('INSERT INTO apps VALUES ($1, $2)', [app.appId, []]);
                }

                // insert as a new version of the app
                const res = await client.lquery(
                    'INSERT INTO app_versions(app, store, region, version, downloaded, last_dl_attempt, analyzed )' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [app.appId, 'play', region, app.version, 0, 'epoch', 0]
                );
                verId = res.rows[0].id;

                // update apps table to have the new version in the app version array.
                await client.lquery('UPDATE apps SET versions=versions || $1 WHERE id = $2', [
                    [verId], app.appId,
                ]);
            
                if (!app.price && app.price != 0) {
                    app.price = 0;
                }

                await client.lquery(
                    'INSERT INTO playstore_apps VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, current_date, $21, $22, $23)', [
                    verId,
                    app.title,
                    null, /* ToDo: Summary does not exist on iOS */
                    app.description,
                    app.url,
                    app.price,
                    app.free,
                    app.score,
                    app.reviews,
                    app.primaryGenreId, /* ToDo: iOS apps can have multiple genres */
                    null, /* ToDO: Family genre does not exist on iOS */
                    null, /* ToDo: No install counts on iOS */
                    null, /* ToDo: No install counts on iOS */
                    devId,
                    new Date(app.updated),
                    app.requiredOsVersion,
                    app.contentRating,
                    app.screenshots,
                    null, /* No video on iOS */
                    [app.releaseNotes],
                    null, /* permissions will be added later */
                    new Date(app.released),
                    app.privacyLabels
                ]);
            }
            await client.lquery('COMMIT');
        } catch (e) {
            logger.debug(e);
            await client.lquery('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        return verId;
    }

    async getMissingPrivacyLabels() {
        try {
            logger.debug('Fetching Missing Privacy labels');
            const res = await this.query('SELECT p.id, app, store_url FROM playstore_apps p JOIN app_versions v ON v.id = p.id WHERE privacy_labels is null');
            logger.debug(`${res.rows.length} apps found`);
            return res.rows;
        } catch (err) {
            logger.err('Error getting missing privacy labels', err);
            throw err;
        }
    }

    async updatePrivacyLabel(id, privacyLabels) {
        try {
            await this.query('UPDATE playstore_apps SET privacy_labels=$2 WHERE id = $1', [id, privacyLabels]);
        } catch (err) {
            logger.err('Error updating privacy labels:', err);
            throw err;
        }
    }
}

module.exports = DB;
