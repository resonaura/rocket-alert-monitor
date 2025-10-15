export interface Post {
    id: string;
    content: string;
    timestamp: Date;
}

export interface User {
    id: string;
    name: string;
    phoneNumber: string;
    isSubscribed: boolean;
}