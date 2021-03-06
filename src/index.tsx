import {DocumentSnapshot, FieldPath, QuerySnapshot, WhereFilterOp} from "@firebase/firestore-types";
import axios from "axios";
import * as firebase from "firebase/app";
import hoist from "hoist-non-react-statics";
import * as React from "react";
import _ from "lodash";

let pkg: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pkg = require("../package.json");
} catch (e) {}

const randomString = function(length: number) {
  let text = "";
  const possible = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

function getNewId() {
  return randomString(16);
}

type Profile = any;
let isProduction = true;

if (process.env.NODE_ENV && process.env.NODE_ENV !== "production") {
  isProduction = false;
}
console.debug("[FireStorm] Production:", isProduction);

const newId = function() {
  let text = "";
  const length = 16;
  const possible = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

type Query = [string | FieldPath, WhereFilterOp, any];
export interface ListenerConfig {
  collection: string;
  id?: string;
  ids?: string[];
  query?: Query;
  queries?: Query[];
  attach?: (data: any) => {[propName: string]: any};
  limit?: number;
  // If set, we'll fetch the document first. This is less performant and should be fixed.
  startAfterId?: string;
  startAfter?: DocumentSnapshot;
  orderBy?: {
    field: string | FieldPath;
    direction?: "desc" | "asc";
  };
  // If once, don't attach listener.
  once?: boolean;
}

export type ListenerCallback = (data: any) => void;
const PROFILE_COLLECTION = "profiles";
const DEFAULT_LIMIT = 20;

interface SaveOptions {
  setOwner?: boolean;
}

export interface FireStormProfile {
  id: string;
  admin?: boolean;
}

// Allow this to work from Node as Admin or directly in React/React-Native
function isFirebaseAdmin(firebase: any) {
  if (Boolean(firebase.credential)) {
    console.debug("[FireStorm] Admin Firebase, not setting up user listeners");
  }
  return Boolean(firebase.credential);
}

function getListenerKey(config: ListenerConfig): string {
  if (!config.id && !config.query && !config.ids) {
    return config.collection;
  } else if (config.id) {
    return `${config.collection}/${config.id}`;
  } else if (config.query) {
    return `${config.collection}?${config.query}`;
  } else if (config.queries) {
    return `${config.collection}?${config.queries.join("&")}`;
  } else if (config.ids) {
    return `${config.collection}?${config.ids.join("&")}`;
  } else {
    console.error("Unkwown FireStorm config", config);
    throw new Error(`Uknown FireStorm config: ${config}`);
  }
}

function extractDocs(snap: QuerySnapshot) {
  const data: {[id: string]: any} = {};
  snap.forEach((d: any) => {
    if (d.id) {
      data[d.id] = d.data();
    }
  });
  return data;
}

class FirestormService<T extends FireStormProfile = FireStormProfile> {
  baseUrl?: string;
  _firebase: firebase.app.App | undefined;
  get firebase(): firebase.app.App {
    if (!this._firebase) {
      throw new Error("[FireStorm] Tried to use Firestore before init() was called.");
    }
    return this._firebase;
  }

  _firestore: firebase.firestore.Firestore | undefined;
  get firestore(): firebase.firestore.Firestore {
    if (!this._firestore) {
      throw new Error("[FireStorm] Tried to use Firestore before init() was called.");
    }
    return this._firestore;
  }

  listeners: {[listenerKey: string]: any} = {};
  listenerCallbacks: {
    [listenerKey: string]: {[callbackId: string]: ListenerCallback};
  } = {};
  data: {[listenerKey: string]: any} = {};
  profile?: T;
  authStateListener: any;
  userChangeCallbacks: ((profile?: T) => void)[] = [];
  signupData: any = {};

  public signup = async (credential: {email: string; password: string}) => {
    let uid;
    const additionalUserData = {...this.getSignupData()};
    if (credential && credential.email) {
      const userCredential = await this.firebase
        .auth()
        .createUserWithEmailAndPassword(credential.email, credential.password);
      uid = userCredential && userCredential.user && userCredential.user.uid;
    } else {
      console.error("[FireStorm] Unsupported login method.", credential);
      throw new Error("[FireStorm] Unsupported login method.");
    }

    if (!uid) {
      throw new Error("[FireStorm] No user uid found after logging in.");
    }
    this.addListener({collection: PROFILE_COLLECTION, id: uid}, (data: any) => {
      this.profile = data;
    });

    this.signupData = {};

    return this.saveDocument(PROFILE_COLLECTION, {
      id: uid,
      email: credential.email,
      ...additionalUserData,
    });
  };

  public login = async (credential: {email: string; password: string}) => {
    let uid: string;
    if (credential && credential.email) {
      const userCredential = await this.firebase
        .auth()
        .signInWithEmailAndPassword(credential.email, credential.password);
      const userId = userCredential && userCredential.user && userCredential.user.uid;
      if (!userId) {
        throw new Error("[FireStorm] No user uid found after logging in.");
      }
      uid = userId;
    } else {
      console.error("[FireStorm] Unsupported login method.", credential);
      throw new Error("Unsupported login method.");
    }
    this.addListener({collection: PROFILE_COLLECTION, id: uid}, (data: any) => {
      this.profile = data;
    });
    const snapshot = await this.firestore
      .collection(PROFILE_COLLECTION)
      .doc(uid)
      .get();
    this.signupData = {};
    return snapshot.data();
  };

  private reset = () => {
    this.data = {};
    this.profile = undefined;
    this.signupData = {};
    for (const listener of Object.values(this.listeners)) {
      listener();
    }
    this.listeners = {};
    this.listenerCallbacks = {};
  };

  private getAuthToken = async () => {
    const user = await this.firebase.auth().currentUser;
    if (!user) {
      return null;
    } else {
      return await user.getIdToken();
    }
  };

  public logout = async () => {
    this.reset();
    return this.firebase.auth().signOut();
  };

  public updateProfile = async (update: Partial<Profile>) => {
    const user = this.getUser();
    if (!user) {
      // Useful for saving data pre-signup. This data should be passed to this.signup as
      // `additionalUserInfo`
      console.debug(`[FireStorm] Updating signup data:`, update);
      this.signupData = {...this.signupData, ...update};
    } else {
      console.debug(`[FireStorm] Updating user id: ${user.id}`, update);
      await this.firestore
        .collection(PROFILE_COLLECTION)
        .doc(user.id)
        .update({...update, updated: new Date()});
    }
  };

  public getSignupData = () => {
    return this.signupData || {};
  };

  public getUser = () => {
    return this.profile;
  };

  public getUserOrSignupData = () => {
    if (Object.keys(this.signupData || {}).length > 0) {
      return this.getSignupData();
    } else {
      return this.getUser();
    }
  };

  private buildQuery = (config: ListenerConfig) => {
    const queryLog: any[] = [];
    let query;
    if (config.query) {
      query = this.firestore
        .collection(config.collection)
        .where(config.query[0] as string, config.query[1], config.query[2]);
      queryLog.push({collection: config.collection});
      queryLog.push({
        where: [config.query[0] as string, config.query[1], config.query[2]],
      });
      // .orderBy("updated", "desc");
    } else if (config.queries) {
      query = this.firestore.collection(config.collection);
      queryLog.push({collection: config.collection});

      for (const q of config.queries) {
        query = query.where(q[0] as string, q[1], q[2]);
        queryLog.push({where: [q[0] as string, q[1], q[2]]});
      }
    } else {
      query = this.firestore.collection(config.collection).orderBy("updated", "desc");
      queryLog.push({collection: config.collection});
      queryLog.push({orderBy: ["updated", "desc"]});
    }
    // if (config.orderBy) {
    //   query.orderBy(config.orderBy.field, config.orderBy.direction);
    // }

    if (config.startAfter) {
      query = query.startAfter(config.startAfter);
      queryLog.push({startAfter: config.startAfter});
    }

    if (config.orderBy) {
      query = query.orderBy(
        config.orderBy.field,
        config.orderBy.direction === "desc" ? "desc" : undefined
      );
      queryLog.push({orderBy: config.orderBy});
    }

    query = query.limit(config.limit || DEFAULT_LIMIT);
    queryLog.push({limit: config.limit || DEFAULT_LIMIT});

    console.debug("[FireStorm] Making query:", queryLog);
    return query;
  };

  public addListener = async (config: ListenerConfig, callback: (data: any) => void) => {
    // let config = typeof c === "string" ? {collection: c} : c;
    // console.debug("[FireStorm] Adding listener", config);

    if (config.id && config.ids) {
      throw new Error("Cannot have both `id` and `ids` set for FireStorm config.");
    } else if ((config.id && config.query) || (config.id && config.queries)) {
      throw new Error("Cannot have `id` and `query` or `queries` set for FireStorm config.");
    } else if ((config.ids && config.query) || (config.ids && config.queries)) {
      throw new Error("Cannot have `ids` and `query` or `queries` set for FireStorm config.");
    }

    // If the document id isn't set yet, don't listen to the whole collection (which may be a
    // firestore permissions error).
    if (Object.keys(config).indexOf("id") !== -1 && !config["id"]) {
      return;
    }

    const listenerKey = getListenerKey(config);
    if (!this.listenerCallbacks[listenerKey]) {
      this.listenerCallbacks[listenerKey] = {};
    }
    const listenerId = newId();
    this.listenerCallbacks[listenerKey][listenerId] = callback;

    if (!this.listeners[listenerKey]) {
      await this.setupListener(config);
    }

    // Immediately return data if we have it.
    if (this.data[listenerKey]) {
      callback(this.data[listenerKey]);
    }

    const unsubscribe = () => {
      if (
        !this.listenerCallbacks[listenerKey] ||
        !this.listenerCallbacks[listenerKey][listenerId]
      ) {
        return;
      }
      delete this.listenerCallbacks[listenerKey][listenerId];
      if (Object.keys(this.listenerCallbacks[listenerKey]).length === 0) {
        if (this.listeners[listenerKey]) {
          this.listeners[listenerKey]();
        }
      }
    };
    return unsubscribe;
  };

  private onSubscriptionError = async (config: ListenerConfig, error: any) => {
    console.error(`[FireStorm] Subscription error for ${getListenerKey(config)}`, error);
  };

  // Starts listening for data then dispatches that data to all the listenerCallbacks.
  private setupListener = async (config: ListenerConfig) => {
    const listenerKey = getListenerKey(config);
    if (!config.id && !config.ids) {
      if (this.listeners[listenerKey]) {
        console.debug(
          "[FireStorm] Already listening to collection, not adding another subscription",
          config
        );
        return;
      }
      const onSnapshot = (snap: any) => {
        this.data[listenerKey] = extractDocs(snap);
        this.sendDataToCallbacks(listenerKey);
      };
      this.listeners[listenerKey] = this.buildQuery(config).onSnapshot(onSnapshot, (error: any) =>
        this.onSubscriptionError(config, error)
      );

      let result;
      try {
        result = await this.buildQuery(config).get();
      } catch (error) {
        console.error("[FireStorm] Error on initial collection/wher fetch", error);
        return;
      }
      onSnapshot(result);
    } else if (config.id) {
      const onSnapshot = (snap: DocumentSnapshot) => {
        if (snap.exists) {
          this.data[listenerKey] = snap.data();
        } else {
          this.data[listenerKey] = undefined;
        }
        this.sendDataToCallbacks(listenerKey);
      };
      console.debug("[FireStorm] Mounting listener", config);
      this.listeners[listenerKey] = this.firestore
        .collection(config.collection)
        .doc(config.id)
        .onSnapshot(onSnapshot, (error: any) => this.onSubscriptionError(config, error));
      let result;
      try {
        result = await this.firestore
          .collection(config.collection)
          .doc(config.id)
          .get();
      } catch (error) {
        console.error("[FireStorm] Error on initial document fetch", error);
        return;
      }
      onSnapshot(result);
    } else if (config.ids) {
      this.getDocuments(config).then((docs) => {
        // Promise so we don't have to await and not return right away
        this.data[listenerKey] = docs;
        this.sendDataToCallbacks(listenerKey);
      });
    } else {
      console.warn("Unknown config for listener", config);
      throw new Error("[FireStorm] Unknown config for listener");
    }
  };

  private sendDataToCallbacks = (listenerKey: string) => {
    if (!this.listenerCallbacks[listenerKey]) {
      console.warn(`[FireStorm] No listeners for ${listenerKey}`);
      return;
    }
    const data = Object.freeze(this.data[listenerKey]);
    for (const cb of Object.values(this.listenerCallbacks[listenerKey])) {
      cb(data);
    }
  };

  public getDocuments = async (config: ListenerConfig): Promise<{[id: string]: any}> => {
    let docs;

    if (config.startAfterId && !config.startAfter) {
      config.startAfter = await this.firestore
        .collection(config.collection)
        .doc(config.startAfterId)
        .get();
    }

    if (config.ids) {
      const data: {[id: string]: any} = {};
      let docs;
      try {
        docs = await Promise.all(
          config.ids.map((id: string) => this.getDocument(config.collection, id))
        );
      } catch (e) {
        console.error(`[FireStorm] Error getting ids: ${getListenerKey(config)}`);
        throw e;
      }
      for (const doc of docs) {
        if (!doc) {
          continue;
        }
        data[doc.id] = doc;
      }
      return data;
    } else {
      try {
        const query = this.buildQuery(config);
        docs = await query.get();
      } catch (e) {
        console.error(`[FireStorm] Error getting collection from config:`, config, e);
        throw e;
      }
      return extractDocs(docs);
    }
  };

  public getDocument = async (collection: string, id: string) => {
    let doc;
    try {
      doc = await this.firestore
        .collection(collection)
        .doc(id)
        .get();
    } catch (e) {
      console.error(`[FireStorm] Error getting doc: ${collection}/${id}`, e);
      throw e;
    }
    if (doc.exists) {
      return doc.data();
    } else {
      return undefined;
    }
  };

  public updateDocument = async (collection: string, id: string, partial: any) => {
    if (!id) {
      console.error("Cannot update a document with no id", collection, partial);
      throw new Error("Cannot update a document with no id.");
    }
    this.firestore
      .collection(collection)
      .doc(id)
      .update(partial);
  };

  public saveDocument = async (collection: string, document: any, options: SaveOptions = {}) => {
    if (!document) {
      console.warn(`Tried to save undefined document to collection: ${collection}`);
      return;
    }
    if (!document.id) {
      console.warn(`Tried to save document without id to collection: ${collection}`, document);
      throw new Error(`Tried to save document without id to collection: ${collection}`);
    }
    let doc;
    try {
      doc = await this.firestore
        .collection(collection)
        .doc(document.id)
        .get();
    } catch (error) {
      console.error("Error saving doc", {
        collection,
        id: document.id,
        document,
        error,
      });
      throw error;
    }

    let extraData = {};
    const user = this.getUser();
    if (options.setOwner && user) {
      extraData = {...extraData, ownerId: user.id};
    }
    document = {...document, ...extraData};

    if (doc.exists) {
      // console.debug(`[FireStorm] Updating ${collection} id: ${document.id}`, document);
      try {
        await this.firestore
          .collection(collection)
          .doc(document.id)
          .update({...document, updated: new Date()});
      } catch (e) {
        console.error(
          `[FireStorm] Error updating doc: ${collection}/${document.id}, update:`,
          document,
          "Error: ",
          e
        );
        throw e;
      }
    } else {
      console.debug(`[FireStorm] Creating ${collection} id: ${document.id}`, document);
      await this.firestore
        .collection(collection)
        .doc(document.id)
        .set({...document, created: new Date(), updated: new Date()});
    }
    return document;
  };

  // TODO: set as .deleted = true, filter everywhere else.
  public deleteDocument = async (collection: string, documentId: string) => {
    try {
      await this.firestore
        .collection(collection)
        .doc(documentId)
        .delete();
    } catch (e) {
      console.error(`[FireStorm] Error deleting document: ${collection}/${documentId}`);
    }
  };

  public init(firebase: firebase.app.App, baseUrl?: string) {
    this._firebase = firebase;
    this._firestore = this.firebase.firestore();
    this.baseUrl = baseUrl;
    console.debug("[FireStorm] Initializing FireStorm, version:", pkg?.version ?? "local");
    if (isFirebaseAdmin(this.firebase)) {
      return;
    }
    this.reset();
    this.firebase.auth().onAuthStateChanged(async (user: any) => {
      console.debug("[FireStorm] auth state changed", user, this.authStateListener);
      if (user) {
        if (!this.authStateListener) {
          this.authStateListener = this.addListener(
            {collection: PROFILE_COLLECTION, id: user.uid},
            (data: any) => {
              this.profile = data;
            }
          );
        }
        let profileDoc;
        try {
          profileDoc = (await this.getDocument(PROFILE_COLLECTION, user.uid)) as T;
        } catch (e) {
          console.error("[FireStorm] Error fetching profile doc", user.uid);
        }
        if (profileDoc) {
          this.profile = profileDoc;
          console.debug("[FireStorm] Found user profile", profileDoc);
          for (const cb of this.userChangeCallbacks) {
            cb && cb(this.profile);
          }
        } else {
          console.warn("[FireStorm] Could not find matching profile for user", user.uid);
        }
      } else if (!user) {
        for (const cb of this.userChangeCallbacks) {
          cb && cb(undefined);
        }
      }
    });
  }

  public onProfileStateChanged(callback: (profile: any) => void) {
    if (this.profile && this.profile.id) {
      callback(this.profile);
      return;
    }
    this.userChangeCallbacks.push(callback);
  }

  public async call(fnName: string, data: any) {
    const fn = this.firebase.functions().httpsCallable(fnName);
    let res;
    try {
      res = await fn(data);
    } catch (e) {
      console.warn(`[FireStorm] Error calling function ${fnName} with data:`, data, "Error: ", e);
      throw e;
    }
    return res.data;
  }

  public apiCall = (
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" = "GET",
    data?: any
  ) => {
    if (!this.baseUrl) {
      console.error("[FireStorm] Cannot make API calls without setting baseUrl in init().");
      return;
    }
    return new Promise(async (resolve) => {
      const userIdToken = await this.getAuthToken();
      try {
        if (!userIdToken) {
          console.warn(`[FireStorm] No API token set`);
          return;
        }
        console.debug("Making API Call to", this.baseUrl, url, method);
        const result = await axios({
          baseURL: this.baseUrl,
          timeout: 15000,
          url,
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${userIdToken}`,
          },
          data,
        });

        console.debug("[FireStorm] API response", result.status, result.statusText);
        resolve(result && result.data ? result.data : {});
      } catch (e) {
        console.debug(`[FireStorm] Giving up on sending API request`, {
          token: userIdToken,
          url,
          // data,
          error: e,
        });
        console.error(`[FireStorm] Giving up on sending API request`, {
          error: e,
        });
      }
    });
  };
}

// TODO figure out how to generic/library this
export const FireStorm = new FirestormService<Profile>();

interface FirestoreModelState {
  data: any;
}

// type Optionalize<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>> & Partial<Pick<T, K>>;

export interface ModelProps<T> {
  save: (document: T) => Promise<T>;
  delete: (document: T) => Promise<void>;
  update: (id: string, document: T) => Promise<void>;
  doc?: T;
  docs?: {[id: string]: T};
}

export const FireStormModel = (
  attachName: string,
  configCallback: (profile?: FireStormProfile) => ListenerConfig | undefined,
  extraProps: {[prop: string]: any} = {}
) => <T extends unknown>(WrappedComponent: React.ComponentType<T>): React.ComponentType<T> => {
  // console.log("FIRESTORM MODEL", config);
  // export function FirestoreModel<T extends FirestoreModelProps = FirestoreModelProps>(
  //   WrappedComponent: React.ComponentType<T>
  // ) {
  // Try to create a nice displayName for React Dev Tools.
  const displayName = WrappedComponent.displayName || WrappedComponent.name || "Component";

  // Creating the inner component. The calculated Props type here is the where the magic happens. (??)
  class FirestoreModelHOC extends React.Component<T, FirestoreModelState> {
    listener: any;
    profileListener: any;
    config: ListenerConfig | undefined;

    public static displayName = `firestoreModel(${displayName})`;

    constructor(props: T) {
      super(props);
      this.state = {data: undefined};
    }

    async componentDidMount() {
      const profile = FireStorm.getUser();

      if (!profile) {
        FireStorm.onProfileStateChanged(this.setUpListeners);
      } else {
        FireStorm.onProfileStateChanged(this.setUpListeners);
        this.setUpListeners(profile);
      }
    }

    componentWillUnmount() {
      // Unmount the listener
      // console.debug("[FireStorm] Unmounting listener", this.config);
      this.listener && this.listener();
      this.profileListener && this.profileListener();
    }

    onListenerCallback = (data: any) => {
      if (!this.listener) {
        return;
      }
      this.setState({data});
    };

    setUpListeners = async (profile: FireStormProfile) => {
      this.config = configCallback(profile);

      // console.log("FIRESTORM HOC config", this.config && this.config.collection, this.config);
      if (!this.config) {
        this.setState({data: undefined});
        return;
      }
      if (this.config.once) {
        console.warn("`config.once` not yet supported.");
        return;
      }
      this.listener = await FireStorm.addListener(this.config, (data) => {
        // console.log("[FireStorm] HOC LISTENER", this.config && this.config.collection, data);
        // console.log("FIRESTORM HOC data", this.config && this.config.collection, data);
        this.setState({data});
      });
      // Update whenever the profile changes
      if (!this.profileListener) {
        this.profileListener = await FireStorm.addListener(
          {
            collection: PROFILE_COLLECTION,
            id: profile.id,
          },
          (profile) => {
            // console.log(
            //   "FIRESTORM HOC profile update",
            //   this.config && this.config.collection,
            //   profile
            // );
            this.setUpListeners(profile);
          }
        );
      }
    };

    public render() {
      // console.log("[FireStorm] model render");
      if (!this.config) {
        const props = this.props as any;
        return <WrappedComponent {...props} {...{[attachName]: {...extraProps, doc: undefined}}} />;
      }
      const config = this.config;

      let firestormProps: ModelProps<T> = {
        save: (document) => FireStorm.saveDocument(config.collection, document),
        update: (id: string, partial: any) =>
          FireStorm.updateDocument(config.collection, id, partial),
        delete: (document: any) => FireStorm.deleteDocument(config.collection, document.id),
        ...extraProps,
      }; // TODO: the generic should be generic, with these required props
      // TODO pagination, get, read, etc
      if (config.attach) {
        firestormProps = {
          ...firestormProps,
          ...config.attach(this.state.data),
        };
      } else if (config.id) {
        firestormProps.doc = this.state.data;
      } else {
        firestormProps.docs = this.state.data;
      }
      const props = this.props as any;
      return <WrappedComponent {...props} {...{[attachName]: firestormProps}} />;
    }
  }
  // TODO not sure why hoist was messing with the props here.
  const hoisted = hoist(FirestoreModelHOC, WrappedComponent);
  return hoisted;
};

type Omit<T, K extends keyof any> = T extends any ? Pick<T, Exclude<keyof T, K>> : never;

interface WithProfile<Profile> extends ModelProps<Profile> {
  isAdmin: () => boolean;
  isAuthenticated: () => boolean;
  isOwner: (item: {ownerId?: string}) => boolean;
  updateProfile: (update: Partial<Profile>) => void;
}
export interface WithProfileProps {
  profile: WithProfile<Profile>;
}

export const withProfile = <T extends unknown>(
  WrappedComponent: React.ComponentType<T>
): React.ComponentType<Omit<T, keyof WithProfileProps>> => {
  const HOC = (FireStormModel(
    "profile",
    (profile) => {
      // console.debug("[FireStorm] profile hoc profile changed", profile);
      return profile
        ? {
            collection: PROFILE_COLLECTION,
            id: profile.id,
          }
        : undefined;
    },
    {
      isAdmin: () => {
        const user = FireStorm.getUser();
        return Boolean(user && user.admin) || (user && user.email === "josh@nang.io");
      },
      isAuthenticated: () => Boolean(FireStorm.getUser()),
      isOwner: (item: {ownerId?: string}) => {
        const user = FireStorm.getUser();
        return user && item && item.ownerId && user.id === item.ownerId;
      },
      updateProfile: (update: any) => FireStorm.updateProfile(update),
    }
  )(WrappedComponent) as unknown) as React.ComponentType<Omit<T, keyof WithProfileProps>>;
  return HOC;
};

export const FireStormHOC = (
  attachName: string,
  Model: FireStormDocument,
  configCallback: (profile?: FireStormProfile) => ListenerConfig,
  extraProps: {[prop: string]: any} = {}
) => <T extends unknown>(WrappedComponent: React.ComponentType<T>): React.ComponentType<T> => {
  // Try to create a nice displayName for React Dev Tools.
  const displayName = WrappedComponent.displayName || WrappedComponent.name || "Component";

  // Creating the inner component. The calculated Props type here is the where the magic happens.
  class FireStormModelHOC extends React.Component<T, FirestoreModelState> {
    listener: any;
    profileListener: any;
    config: ListenerConfig | undefined;
    onceComplete = false;

    public static displayName = `FireStormHOC(${displayName})`;

    constructor(props: T) {
      super(props);
      this.state = {data: undefined};
    }

    async componentDidMount() {
      const profile = FireStorm.getUser();
      FireStorm.onProfileStateChanged(this.setUpListeners);

      if (profile) {
        this.setUpListeners(profile);
      } else {
        console.warn("No profile, cannot set up FireStormHOC");
      }
    }

    componentWillUnmount() {
      this.removeListeners();
    }

    onListenerCallback = (data: any) => {
      if (!this.listener) {
        return;
      }
      if (this.config?.once) {
        if (this.onceComplete) {
          return;
        }
        this.onceComplete = true;
      }
      this.setState({data});
    };

    setUpListeners = async (profile: FireStormProfile) => {
      this.config = configCallback(profile);
      this.listener = await FireStorm.addListener(this.config, (data) => this.setState({data}));
    };

    removeListeners = () => {
      this.listener && this.listener();
      this.profileListener && this.profileListener();
    };

    public render() {
      const props = this.props as any;

      let data;
      if (!this.config) {
        data = {};
      } else if (this.config.id) {
        data = new (Model as any)(data);
      } else {
        data = [];
        for (const id of Object.keys(this.state.data)) {
          data.push(new (Model as any)(this.state.data[id]));
        }
      }

      return <WrappedComponent {...props} {...{[attachName]: data}} {...extraProps} />;
    }
  }
  return hoist(FireStormModelHOC, WrappedComponent);
};

export type FireStormSchemaField =
  | typeof String
  | typeof Number
  | typeof Boolean
  | typeof Array
  | typeof Date
  | typeof Object;
export interface FireStormSchemaComplexField {
  required?: boolean;
  type: FireStormSchemaField;
  validate?: (key: string, value: any) => boolean;
}

export interface FireStormSchemaConfig {
  [name: string]: FireStormSchemaField;
}

function isComplexField(
  value: FireStormSchemaComplexField | FireStormSchemaField
): value is FireStormSchemaComplexField {
  return (value as any).type;
}

type FireStormSchemaStatic = () => void;
type FireStormInstanceMethod = () => void;

export class FireStormSchema {
  collection: string;
  config: FireStormSchemaConfig;
  _statics: {[name: string]: FireStormSchemaStatic} = {};
  _methods: {[name: string]: FireStormInstanceMethod} = {};
  // Optionally set this for tests.
  firestorm?: FirestormService;

  constructor(collection: string, config: FireStormSchemaConfig, firestorm?: FirestormService) {
    this.collection = collection;
    this.config = config;
    this.firestorm = firestorm;
  }

  static(name: string, fn: () => void) {
    this._statics[name] = fn.bind(this);
    this[name] = fn.bind(this);
  }

  method(name: string, fn: () => void) {
    this._methods[name] = fn.bind(this);
  }

  isKey(key: string): boolean {
    return Boolean(this.config[key]);
  }

  validate(key: string, value: any) {
    const name = this.config.name;

    if (!this.isKey(key)) {
      throw new Error(`ValidationFailed(${name}): ${key} is not part of the  schema.`);
    }

    let valueType: FireStormSchemaField;
    const config = this.config[key];
    if (isComplexField(config)) {
      valueType = config.type;

      if ((config.required === true && value === undefined) || value === null) {
        throw new Error(`ValidationFailed(${name}): ${key} is required`);
      }
      if (config.validate) {
        config.validate(key, value);
      }
    } else {
      valueType = config;
    }

    switch (valueType) {
      case String:
        if (!_.isString(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is not a string, value: ${value}`);
        }
        break;
      case Number:
        if (!_.isNumber(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is not a number, value: ${value}`);
        }
        break;
      case Boolean:
        if (!_.isBoolean(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is not a boolean, value: ${value}`);
        }
        break;
      case Array:
        if (!_.isArray(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is not an array, value: ${value}`);
        }
        break;
      case Date:
        if (!_.isDate(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is not a date, value: ${value}`);
        }
        break;
      case Object:
        if (!_.isObject(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is not an object, value: ${value}`);
        }
        if (_.isArray(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is an array, not an object: ${value}`);
        }
        if (_.isDate(value)) {
          throw new Error(`ValidationFailed(${name}): ${key} is a date, not an object: ${value}`);
        }
        break;
      default:
        throw new Error(`ValidationFailed(${name}): unkonwn value type ${valueType}`);
    }
  }
}

export function registerSchema(name: string, schema: FireStormSchema) {
  return FireStormDocument.bind(null, name, schema);
}

// TODO: support versioning a la Mongoose
export class FireStormDocument {
  id: string;
  _name: string;
  _schema: FireStormSchema;
  _methods: {[name: string]: FireStormInstanceMethod};
  _firestorm: FirestormService;

  constructor(name: string, schema: FireStormSchema, data?: any) {
    this._name = name;
    this._schema = schema;
    this._methods = schema._methods;
    this._firestorm = schema.firestorm || FireStorm;

    for (const methodName of Object.keys(schema._methods)) {
      this[methodName] = schema._methods[methodName].bind(this);
    }
    for (const key of Object.keys(data)) {
      if (!schema.isKey(key)) {
        throw new Error(`${key} is not part of the ${name} schema.`);
      }
      this[key] = data[key];
    }

    if (!data.id) {
      this.id = getNewId();
    } else {
      this.id = data.id;
    }
  }

  async validate() {
    for (const key of Object.keys(this._schema.config)) {
      this._schema.validate(key, this[key]);
    }
  }

  async save() {
    await this.validate();

    const data = {id: this.id};
    for (const key of Object.keys(this._schema.config)) {
      data[key] = _.cloneDeep(this[key]);
    }
    await this._firestorm.saveDocument(this._schema.collection, data);
  }

  async delete() {
    await this._firestorm.deleteDocument(this._schema.collection, this.id);
  }

  async update(partialUpdate: any) {
    for (const key of Object.keys(partialUpdate)) {
      this[key] = partialUpdate[key];
    }
    await this.validate();
    await this._firestorm.updateDocument(this._schema.collection, this.id, partialUpdate);
    // TODO should roll the doc back on failure.
  }
}
